// Compra web por número visible de Tienda Nube: traduce al pedido de Odoo (TN<id interno>)
// y lee la compra con el código de devoluciones del POS.

// Odoo devuelve 'YYYY-MM-DD HH:MM:SS' en UTC sin zona.
export function odooDateToISO(s) {
  if (!s || typeof s !== 'string') return s ?? null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}.000Z`;
  return s;
}

// Imports lazy: los módulos de Odoo/Firestore no se cargan hasta usarlos.
function defaultDeps() {
  return {
    findOrderByNumber: async (n) => (await import('./tiendanube.mjs')).findOrderByNumber(n),
    findSaleOrder: async (name) => {
      const { defaultOdoo } = await import('./posOdoo.mjs');
      const rows = await defaultOdoo.read('sale.order', 'search_read', [[['name', '=', name]]], { fields: ['id', 'name', 'warehouse_id'], limit: 1 });
      return rows?.[0] ?? null;
    },
    getPurchase: async (source, id) => (await import('./posReturnsService.mjs')).getPurchase(source, id),
    settings: undefined,
  };
}

const availableOf = (l) => (Number(l.qtyBought) || 0) - (Number(l.qtyReturnedBefore) || 0);

export async function resolveWebPurchase(tnNumber, deps = defaultDeps()) {
  const n = String(tnNumber ?? '').replace(/^[#\s]+/, '').trim();
  const tn = await deps.findOrderByNumber(n);
  if (!tn) throw new Error(`No encontramos el pedido #${n} en Tienda Nube`);
  const so = await deps.findSaleOrder(`TN${tn.id}`);
  if (!so) throw new Error(`El pedido #${n} todavía no está en Odoo`);
  const settings = deps.settings ?? (await (await import('./posConfig.mjs')).getSettings());
  if (so.warehouse_id?.[0] !== settings?.webReturns?.warehouseId) {
    throw new Error(`El pedido #${n} no salió del depósito E Commerce`);
  }
  const raw = await deps.getPurchase('web', so.id);
  const lines = (raw.lines ?? []).map((l) => ({ ...l, purchaseDate: odooDateToISO(l.purchaseDate) }));
  const purchase = { ...raw, date: odooDateToISO(raw.date), lines, ref: n, tnOrderId: tn.id };
  const returnable = lines.map((l) => ({ ...l, available: availableOf(l) })).filter((l) => l.available > 0);
  if (!returnable.length) throw new Error('Ese pedido ya no tiene productos para devolver');
  return { tn, purchase, returnable };
}

export function resolveReturnLine(purchase, { purchaseLineId, qty }) {
  const l = (purchase?.lines ?? []).find((x) => String(x.purchaseLineId) === String(purchaseLineId));
  if (!l) throw new Error('Esa línea no está en la compra');
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 1) throw new Error('Cantidad inválida');
  const available = availableOf(l);
  if (q > available) throw new Error(`Solo se puede devolver ${available}`);
  return { purchaseLineId: l.purchaseLineId, productId: l.productId, sku: l.sku, name: l.name, qty: q, unitValue: l.unitValue, moveIds: l.moveIds, lots: l.lots };
}
