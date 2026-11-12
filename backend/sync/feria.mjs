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

const CURSOR_OVERLAP_MS = 60_000;

// What to read and what to remember afterwards. Docs synced before the sales
// team was stored need one full re-sync; a sinceOverride run (backfill.mjs)
// may not reach back far enough, so it never marks that re-sync done. The
// next cursor is when this run STARTED (minus a minute of overlap): an order
// edited while the sync is running is re-read next time instead of skipped.
export function feriaSyncWindow(meta, sinceOverride, startedAt = new Date()) {
  const backfillDone = !!meta?.teamsBackfilled;
  const cursor = backfillDone ? meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') : null;
  const since = sinceOverride || cursor || '2000-01-01 00:00:00';
  const lastSyncedAt = new Date(startedAt.getTime() - CURSOR_OVERLAP_MS).toISOString();
  return {
    since,
    nextMeta: (count) => ({ lastSyncedAt, count, teamsBackfilled: sinceOverride ? backfillDone : true }),
  };
}

export async function syncFeria(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('feria');
  const { since, nextMeta } = feriaSyncWindow(meta, sinceOverride, new Date());

  const domain = [['team_id', 'in', FERIA_TEAM_IDS], ['write_date', '>=', since]];
  const orders = await fetchAll('sale.order', domain, ['id', 'date_order', 'amount_total', 'state', 'order_line', 'team_id']);

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
    { channel: 'feria', team: true },
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('feria', nextMeta(docs.length));

  console.log(`[sync:feria] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
