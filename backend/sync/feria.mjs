import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooSaleOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

// Each of these Odoo sales teams is a different trade fair/expo the
// business exhibits at — which one is actively selling changes over time
// (verified live: "Presentes" is the current one, "Feria"/"Feria
// Showroom"/"Feria noviembre"/"Expo Construir"/"Hotelga" are past or
// dormant events) — so they're all grouped under one "feria" reporting
// channel rather than needing a new dashboard channel per event.
const FERIA_TEAM_IDS = [10, 20, 21, 22, 23, 24];

const CHUNK_SIZE = 2000;

export async function syncFeria(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('feria');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  const domain = [['team_id', 'in', FERIA_TEAM_IDS], ['write_date', '>=', since]];
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
    { channel: 'feria' },
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('feria', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:feria] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
