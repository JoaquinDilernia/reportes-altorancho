import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const MAYORISTA_TEAM_ID = 8;

// Odoo RPC has a ~30s timeout and practical request-size limits, so id-list
// calls covering the full 14-month backfill (hundreds of thousands of ids)
// must be chunked into multiple sequential requests.
const CHUNK_SIZE = 2000;

// Mayorista orders are confirmed (state=sale, counted in amount_total) well
// before they're invoiced and paid, so amount_total alone overstates cash
// actually collected. account.move's amount_total - amount_residual is the
// paid portion of each invoice; sum that across an order's invoice_ids.
async function fetchCollectedByOrderId(orders) {
  const allInvoiceIds = orders.flatMap(o => o.invoice_ids);
  const collectedByInvoiceId = new Map();
  for (const idChunk of chunk(allInvoiceIds, CHUNK_SIZE)) {
    if (!idChunk.length) continue;
    const invoices = await callKw('account.move', 'read', [idChunk], {
      fields: ['amount_total', 'amount_residual'],
    });
    for (const inv of invoices) {
      collectedByInvoiceId.set(inv.id, inv.amount_total - inv.amount_residual);
    }
  }

  const collectedByOrderId = new Map();
  for (const order of orders) {
    const collected = order.invoice_ids.reduce((sum, id) => sum + (collectedByInvoiceId.get(id) || 0), 0);
    collectedByOrderId.set(order.id, collected);
  }
  return collectedByOrderId;
}

export async function syncMayorista(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('mayorista');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  // Filter on write_date (last-modified), not date_order (creation time):
  // an order created in draft in one sync window but confirmed to `sale`
  // later would otherwise never be re-fetched once its date_order falls
  // before `since`, leaving it stuck as pending forever. write_date also
  // catches orders whose invoice got paid after the order itself synced,
  // which is exactly when amountCollected needs to be refreshed.
  const domain = [['team_id', '=', MAYORISTA_TEAM_ID], ['write_date', '>=', since]];
  const orders = await fetchAll('sale.order', domain, ['id', 'date_order', 'amount_total', 'state', 'order_line', 'invoice_ids']);

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

  const collectedByOrderId = await fetchCollectedByOrderId(orders);

  const docs = orders.map(order => normalizeOdooSaleOrder(
    order,
    linesByOrderId.get(order.id) || [],
    categoryBySku,
    { amountCollected: collectedByOrderId.get(order.id) || 0 },
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('mayorista', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:mayorista] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
