import { authenticate, callKw, fetchAll, chunk } from '../odoo.mjs';
import { normalizeOdooEcommerceOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

const TIENDANUBE_TEAM_ID = 1;

// Odoo RPC has a ~30s timeout and practical request-size limits, so id-list
// calls covering the full 14-month backfill (hundreds of thousands of ids)
// must be chunked into multiple sequential requests.
const CHUNK_SIZE = 2000;

async function fetchLinesByOrderId(lineIds) {
  const linesByOrderId = new Map();
  if (!lineIds.length) return linesByOrderId;

  for (const idChunk of chunk(lineIds, CHUNK_SIZE)) {
    const lines = await callKw('sale.order.line', 'read', [idChunk], {
      fields: ['order_id', 'product_id', 'product_uom_qty', 'price_subtotal'],
    });
    for (const line of lines) {
      if (!line.product_id) continue; // note/section lines (display_type set, no actual product)
      const orderId = line.order_id[0];
      if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
      linesByOrderId.get(orderId).push(line);
    }
  }
  return linesByOrderId;
}

async function fetchProvinceByPartnerId(partnerIds) {
  const provinceByPartnerId = new Map();
  const uniqueIds = [...new Set(partnerIds)];
  if (!uniqueIds.length) return provinceByPartnerId;

  for (const idChunk of chunk(uniqueIds, CHUNK_SIZE)) {
    const partners = await callKw('res.partner', 'read', [idChunk], { fields: ['state_id'] });
    for (const p of partners) {
      if (p.state_id) provinceByPartnerId.set(p.id, p.state_id[1]);
    }
  }
  return provinceByPartnerId;
}

export async function syncEcommerce(categoryBySku, sinceOverride) {
  await authenticate();

  const meta = await getSyncMetadata('ecommerce');
  const since = sinceOverride || meta?.lastSyncedAt?.slice(0, 19).replace('T', ' ') || '2000-01-01 00:00:00';

  // Only orders actually placed through Tiendanube (tiendanube_order_id set) count
  // as ecommerce — the same "Tienda Nube" sales team in Odoo also holds manually
  // created orders (exchanges, phone sales, etc.) that must not be counted here.
  // Filter on write_date (last-modified), not date_order, for the same reason
  // mayorista/locales do: an order confirmed/paid after this sync's window opened
  // must still be picked up even if it was originally placed earlier.
  const domain = [
    ['team_id', '=', TIENDANUBE_TEAM_ID],
    ['tiendanube_order_id', '!=', false],
    ['write_date', '>=', since],
  ];
  const orders = await fetchAll('sale.order', domain, [
    'id', 'date_order', 'amount_untaxed', 'state', 'order_line',
    'tiendanube_order_id', 'tiendanube_order_payment_status', 'tiendanube_gateway_name',
    'partner_shipping_id',
  ]);

  const [linesByOrderId, provinceByPartnerId] = await Promise.all([
    fetchLinesByOrderId(orders.flatMap(o => o.order_line)),
    fetchProvinceByPartnerId(orders.map(o => o.partner_shipping_id && o.partner_shipping_id[0]).filter(Boolean)),
  ]);

  const docs = orders.map(order => normalizeOdooEcommerceOrder(
    order,
    linesByOrderId.get(order.id) || [],
    categoryBySku,
    order.partner_shipping_id ? provinceByPartnerId.get(order.partner_shipping_id[0]) : null,
  ));

  await saveSalesDocs(docs);
  await setSyncMetadata('ecommerce', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:ecommerce] ${docs.length} órdenes sincronizadas`);
  return { count: docs.length };
}
