// Ventas del POS propio de locales (sale.order con número interno LL-/BL-/AL-
// en client_order_ref) a los mismos canales del dashboard que las del Punto
// de Venta de Odoo (sync/locales.mjs, que sigue sumando las ventas viejas).
import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

export const POS_STORES = [
  { teamId: 6, prefix: 'LL-', channel: 'local_lomas' },
  { teamId: 18, prefix: 'BL-', channel: 'local_belgrano' },
  { teamId: 25, prefix: 'AL-', channel: 'local_alcorta' },
];
const CHUNK_SIZE = 2000;

export const posDocId = (channel, orderId) => `${channel}_so_${orderId}`;

export function toPosDoc(order, lines, channel, categoryBySku) {
  const doc = normalizeOdooSaleOrder(order, lines, categoryBySku, { channel });
  return { ...doc, id: posDocId(channel, order.id) };
}

export async function syncPosLocales(categoryBySku, sinceOverride) {
  await authenticate();
  const results = {};
  for (const store of POS_STORES) {
    const metaKey = `${store.channel}_pos`;
    // Cursor taken before querying Odoo, minus a 2-min overlap: orders written in
    // Odoo while this run is in flight would otherwise fall before the next cursor.
    const cursor = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const meta = await getSyncMetadata(metaKey);
    const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';
    const orders = await fetchAll('sale.order', [
      ['team_id', '=', store.teamId], ['client_order_ref', '=like', `${store.prefix}%`], ['write_date', '>=', since],
    ], ['id', 'date_order', 'amount_total', 'state', 'order_line']);
    const linesByOrderId = new Map();
    for (const ids of chunk(orders.flatMap((o) => o.order_line), CHUNK_SIZE)) {
      const lines = await callKw('sale.order.line', 'read', [ids], { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit'] });
      for (const line of lines) {
        if (!line.product_id) continue;
        const id = line.order_id[0];
        if (!linesByOrderId.has(id)) linesByOrderId.set(id, []);
        linesByOrderId.get(id).push(line);
      }
    }
    const docs = orders.map((o) => toPosDoc(o, linesByOrderId.get(o.id) || [], store.channel, categoryBySku));
    await saveSalesDocs(docs);
    await setSyncMetadata(metaKey, { lastSyncedAt: cursor, count: docs.length });
    results[store.channel] = docs.length;
    console.log(`[sync:posLocales] ${store.channel}: ${docs.length} pedidos`);
  }
  return results;
}
