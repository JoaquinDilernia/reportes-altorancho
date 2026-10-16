// Estadísticas del POS a partir de los pedidos confirmados (Firestore). Los
// importes son con IVA; `net` es el total sin IVA.
import { paymentsOf } from './posCash.mjs';
import { netOfIva, round2 } from './posPricing.mjs';

const ms = (v) => (v?.toMillis ? v.toMillis() : new Date(v).getTime());

export function monthsBetween(from, to) {
  const months = [];
  const shift = (d) => new Date(new Date(d).getTime() - 3 * 60 * 60 * 1000);
  const start = shift(from);
  const end = shift(to);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return months;
}

function bump(map, key, init, apply) {
  if (!map.has(key)) map.set(key, init());
  apply(map.get(key));
}

export function computePosStats(orders, { from = 0, to = Infinity } = {}) {
  const sold = orders.filter((o) => o.status === 'confirmado' && ms(o.confirmedAt) >= from && ms(o.confirmedAt) < to);
  const byLocal = new Map();
  const bySeller = new Map();
  const byMethod = {};
  const products = new Map();
  let total = 0;
  for (const o of sold) {
    const t = o.totals?.net ?? o.totals?.total ?? 0;
    const isSale = (o.kind ?? 'venta') !== 'devolucion';
    total += t;
    bump(byLocal, o.localId, () => ({ localId: o.localId, sales: 0, total: 0 }), (r) => { r.sales += isSale ? 1 : 0; r.total = round2(r.total + t); });
    bump(bySeller, o.sellerId, () => ({ sellerId: o.sellerId, sellerName: o.sellerName, localId: o.localId, sales: 0, total: 0 }), (r) => { r.sales += isSale ? 1 : 0; r.total = round2(r.total + t); });
    for (const p of paymentsOf(o)) if (p.methodId !== 'saldo') byMethod[p.methodId] = round2((byMethod[p.methodId] ?? 0) + p.amount);
    for (const r of o.refund?.cashBack ?? []) byMethod[r.methodId] = round2((byMethod[r.methodId] ?? 0) - r.amount);
    const factor = 1 - (o.totals?.lineDiscountPct ?? 0) / 100;
    for (const l of (o.lines ?? []).filter((x) => x.status !== 'eliminado')) {
      bump(products, l.sku, () => ({ sku: l.sku, name: l.name, qty: 0, total: 0 }), (r) => {
        r.qty += l.qty;
        r.total = round2(r.total + l.qty * l.basePrice * factor);
      });
    }
    for (const rl of o.returnLines ?? []) {
      bump(products, rl.sku, () => ({ sku: rl.sku, name: rl.name, qty: 0, total: 0 }), (r) => {
        r.qty -= rl.qty;
        r.total = round2(r.total - rl.qty * rl.unitValue);
      });
    }
  }
  total = round2(total);
  const salesCount = sold.filter((o) => (o.kind ?? 'venta') !== 'devolucion').length;
  const byTotal = (a, b) => b.total - a.total;
  return {
    sales: salesCount,
    returns: sold.filter((o) => o.kind === 'devolucion' || o.kind === 'cambio').length,
    total, net: netOfIva(total), averageTicket: salesCount ? round2(total / salesCount) : 0,
    byLocal: [...byLocal.values()].sort(byTotal), bySeller: [...bySeller.values()].sort(byTotal), byMethod,
    topProducts: [...products.values()].filter((p) => p.qty > 0).sort(byTotal).slice(0, 20),
  };
}
