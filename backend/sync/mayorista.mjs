import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const MAYORISTA_TEAM_ID = 8;

// Odoo RPC has a ~30s timeout and practical request-size limits, so id-list
// calls covering the full 14-month backfill (hundreds of thousands of ids)
// must be chunked into multiple sequential requests.
const CHUNK_SIZE = 2000;

export async function syncMayorista(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('mayorista');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  // Filter on write_date (last-modified), not date_order (creation time):
  // an order created in draft in one sync window but confirmed to `sale`
  // later would otherwise never be re-fetched once its date_order falls
  // before `since`, leaving it stuck as pending forever.
  const domain = [['team_id', '=', MAYORISTA_TEAM_ID], ['write_date', '>=', since]];
  const orders = await fetchAll('sale.order', domain, ['id', 'date_order', 'amount_total', 'state', 'order_line']);

  const allLineIds = orders.flatMap(o => o.order_line);
  const linesByOrderId = new Map();
  for (const idChunk of chunk(allLineIds, CHUNK_SIZE)) {
    const lines = await callKw('sale.order.line', 'read', [idChunk], {
      fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit'],
    });
    for (const line of lines) {
      if (!line.product_id) continue; // note/section lines (display_type set, no actual product)
      const orderId = line.order_id[0];
      if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
      linesByOrderId.get(orderId).push(line);
    }
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
