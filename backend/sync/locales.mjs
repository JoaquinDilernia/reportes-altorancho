import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooPosOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const STORES = [
  { configId: 2, channel: 'local_lomas' },
  { configId: 5, channel: 'local_belgrano' },
  { configId: 7, channel: 'local_alcorta' },
];

// Odoo RPC has a ~30s timeout and practical request-size limits, so id-list
// calls covering the full 14-month backfill (hundreds of thousands of ids)
// must be chunked into multiple sequential requests.
const CHUNK_SIZE = 2000;

async function fetchPaymentMethodByOrderId(orderIds) {
  const methodByOrderId = new Map();
  if (!orderIds.length) return methodByOrderId;

  for (const idChunk of chunk(orderIds, CHUNK_SIZE)) {
    const payments = await callKw('pos.payment', 'search_read', [[['pos_order_id', 'in', idChunk]]], {
      fields: ['pos_order_id', 'payment_method_id'],
    });
    for (const p of payments) {
      if (!methodByOrderId.has(p.pos_order_id[0])) {
        methodByOrderId.set(p.pos_order_id[0], p.payment_method_id[1]);
      }
    }
  }
  return methodByOrderId;
}

async function fetchLinesByOrderId(lineIds) {
  const linesByOrderId = new Map();
  if (!lineIds.length) return linesByOrderId;

  for (const idChunk of chunk(lineIds, CHUNK_SIZE)) {
    const lines = await callKw('pos.order.line', 'read', [idChunk], {
      fields: ['order_id', 'product_id', 'qty', 'price_unit'],
    });
    for (const line of lines) {
      const orderId = line.order_id[0];
      if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
      linesByOrderId.get(orderId).push(line);
    }
  }
  return linesByOrderId;
}

export async function syncLocales(categoryBySku, sinceOverride) {
  await authenticate();
  const results = {};

  for (const store of STORES) {
    const meta = await getSyncMetadata(store.channel);
    const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

    // Filter on write_date (last-modified), not date_order (creation time):
    // an order created in one sync window but confirmed/updated later would
    // otherwise never be re-fetched once its date_order falls before `since`.
    const domain = [['config_id', '=', store.configId], ['write_date', '>=', since]];
    const orders = await fetchAll('pos.order', domain, ['id', 'date_order', 'amount_total', 'state', 'lines']);

    const [paymentByOrderId, linesByOrderId] = await Promise.all([
      fetchPaymentMethodByOrderId(orders.map(o => o.id)),
      fetchLinesByOrderId(orders.flatMap(o => o.lines)),
    ]);

    const docs = orders.map(order => normalizeOdooPosOrder(
      order,
      linesByOrderId.get(order.id) || [],
      store.channel,
      categoryBySku,
      paymentByOrderId.get(order.id) || null,
    ));

    await saveSalesDocs(docs);
    await setSyncMetadata(store.channel, { lastSyncedAt: new Date().toISOString(), count: docs.length });
    results[store.channel] = docs.length;
    console.log(`[sync:locales] ${store.channel}: ${docs.length} órdenes`);
  }

  return results;
}
