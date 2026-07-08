import { authenticate, callKw, fetchAll } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const MAYORISTA_TEAM_ID = 8;

export async function syncMayorista(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('mayorista');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  const domain = [['team_id', '=', MAYORISTA_TEAM_ID], ['date_order', '>=', since]];
  const orders = await fetchAll('sale.order', domain, ['id', 'date_order', 'amount_total', 'state', 'order_line']);

  const allLineIds = orders.flatMap(o => o.order_line);
  const lines = allLineIds.length
    ? await callKw('sale.order.line', 'read', [allLineIds], {
        fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit'],
      })
    : [];
  const linesByOrderId = new Map();
  for (const line of lines) {
    if (!line.product_id) continue; // note/section lines (display_type set, no actual product)
    const orderId = line.order_id[0];
    if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
    linesByOrderId.get(orderId).push(line);
  }

  const docs = orders.map(order => normalizeOdooSaleOrder(
    order,
    linesByOrderId.get(order.id) || [],
    categoryBySku,
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('mayorista', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:mayorista] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
