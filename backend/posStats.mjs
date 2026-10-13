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
    const t = o.totals?.total ?? 0;
    total += t;
    bump(byLocal, o.localId, () => ({ localId: o.localId, sales: 0, total: 0 }), (r) => { r.sales += 1; r.total = round2(r.total + t); });
    bump(bySeller, o.sellerId, () => ({ sellerId: o.sellerId, sellerName: o.sellerName, localId: o.localId, sales: 0, total: 0 }), (r) => { r.sales += 1; r.total = round2(r.total + t); });
    for (const p of paymentsOf(o)) byMethod[p.methodId] = round2((byMethod[p.methodId] ?? 0) + p.amount);
    const factor = 1 - (o.totals?.lineDiscountPct ?? 0) / 100;
    for (const l of (o.lines ?? []).filter((x) => x.status !== 'eliminado')) {
      bump(products, l.sku, () => ({ sku: l.sku, name: l.name, qty: 0, total: 0 }), (r) => {
        r.qty += l.qty;
        r.total = round2(r.total + l.qty * l.basePrice * factor);
      });
    }
  }
  total = round2(total);
  const byTotal = (a, b) => b.total - a.total;
  return {
    sales: sold.length, total, net: netOfIva(total), averageTicket: sold.length ? round2(total / sold.length) : 0,
    byLocal: [...byLocal.values()].sort(byTotal), bySeller: [...bySeller.values()].sort(byTotal), byMethod,
    topProducts: [...products.values()].sort(byTotal).slice(0, 20),
  };
}
