// Que el remito de Odoo salga de donde corresponde. Al confirmar, Odoo arma
// los movimientos desde FER/Stock (la raíz del almacén Feria, que es también
// Rolón) y reserva de cualquier ubicación hija: una falla podía quedar
// reservada contra stock de Rolón, y un remito validado a mano en Odoo la
// descontaba de ahí. Acá cada movimiento se apunta a su ubicación real
// (Fallados / exhibición / Rolón) y se vuelve a reservar. Además Fallados es
// stock ficticio: si un producto de falla no tiene stock ahí, se le cargan
// FALLADOS_TOPUP unidades (en el lote FALLADO si se controla por lote).
import { callKw } from './odoo.mjs';
import { ensureAuth, callKwReadWithRetry, findProductIdBySku } from './feriaOdoo.mjs';
import { deliveryLocationId } from './feriaStock.mjs';
import { ensureFalladoLots } from './feriaDelivery.mjs';
import { FALLADOS } from './feriaLines.mjs';

export const FALLADOS_TOPUP = 100;
const INVENTORY = { context: { inventory_mode: true } };


// Movimientos abiertos cuyo origen no es la ubicación de su línea. Puro.
export function planMoveLocations(moves, lines, locationIdFor) {
  const plan = [];
  for (const line of lines) {
    if (!line.odooLineId) continue;
    const target = locationIdFor(line.location);
    for (const m of moves) {
      if (m.sale_line_id?.[0] !== line.odooLineId || ['done', 'cancel'].includes(m.state)) continue;
      if (m.location_id?.[0] !== target) plan.push({ moveId: m.id, pickingId: m.picking_id?.[0] ?? null, locationId: target });
    }
  }
  return plan;
}

async function applyInventory(quantId) {
  const result = await callKw('stock.quant', 'action_apply_inventory', [[quantId]], INVENTORY);
  if (result && result.res_model) throw new Error(`Odoo pidió confirmación (${result.res_model}) al cargar stock en Fallados`);
}

async function setQuantTo(productId, locationId, lotId, qty) {
  const [quant] = await callKwReadWithRetry('stock.quant', 'search_read', [
    [['product_id', '=', productId], ['location_id', '=', locationId], ['lot_id', '=', lotId || false]],
  ], { fields: ['id'], limit: 1 });
  let quantId = quant?.id;
  if (quantId) {
    await callKw('stock.quant', 'write', [[quantId], { inventory_quantity: qty }], INVENTORY);
  } else {
    [quantId] = await callKw('stock.quant', 'create', [[{
      product_id: productId, location_id: locationId, inventory_quantity: qty, ...(lotId ? { lot_id: lotId } : {}),
    }]], INVENTORY);
  }
  await applyInventory(quantId);
}

// Cuánto tiene que quedar en Fallados para que Odoo deje confirmar: este
// Odoo no confirma una venta si el almacén no tiene stock libre suficiente.
// Sin stock en Fallados → FALLADOS_TOPUP; si aun así el libre del almacén no
// alcanza para lo pedido, se suma lo que falta más FALLADOS_TOPUP de margen.
// Devuelve la cantidad a sumar en Fallados (0 = no hace falta). Puro.
export function falladosTopUpDelta({ falladosQty, freeQty, required }) {
  let delta = falladosQty <= 0 ? FALLADOS_TOPUP - falladosQty : 0;
  if (freeQty + delta < required) delta = required - freeQty + FALLADOS_TOPUP;
  return Math.max(0, delta);
}

// `items`: [{ sku, qty }] de las líneas de falla de la venta. Se llama ANTES
// de confirmar en Odoo.
export async function ensureFalladosStock(items) {
  const falladosId = Number(process.env.ODOO_FERIA_LOCATION_FALLADOS_ID);
  const warehouseId = Number(process.env.ODOO_FERIA_WAREHOUSE_ID) || undefined;
  if (!falladosId || !items.length) return [];
  const required = new Map();
  for (const { sku, qty } of items) {
    const id = await findProductIdBySku(sku);
    if (id) required.set(id, (required.get(id) ?? 0) + qty);
  }
  const productIds = [...required.keys()];
  if (!productIds.length) return [];
  const quants = await callKwReadWithRetry('stock.quant', 'search_read', [
    [['product_id', 'in', productIds], ['location_id', '=', falladosId]],
  ], { fields: ['id', 'product_id', 'quantity', 'lot_id'] });
  const products = await callKwReadWithRetry('product.product', 'read', [productIds], {
    fields: ['tracking', 'company_id', 'free_qty'], context: { warehouse: warehouseId },
  });

  const changed = [];
  const tracked = products.filter((p) => p.tracking !== 'none');
  await ensureAuth();
  const lots = tracked.length ? await ensureFalladoLots(tracked.map((p) => p.id), tracked[0].company_id?.[0]) : new Map();
  for (const p of products) {
    const own = quants.filter((q) => q.product_id[0] === p.id);
    const falladosQty = own.reduce((n, q) => n + q.quantity, 0);
    const delta = falladosTopUpDelta({ falladosQty, freeQty: p.free_qty ?? 0, required: required.get(p.id) });
    if (!delta) continue;
    const lotId = p.tracking !== 'none' ? lots.get(p.id) : null;
    const current = own.find((q) => (q.lot_id?.[0] ?? null) === (lotId ?? null))?.quantity ?? 0;
    await setQuantTo(p.id, falladosId, lotId, current + delta);
    changed.push({ productId: p.id, delta });
  }
  if (changed.length) console.log(`[feriaPlacement] Fallados: stock sumado a ${changed.length} producto(s) para poder confirmar`);
  return changed;
}

// Apunta cada movimiento del remito a la ubicación de su línea y reserva de
// nuevo desde ahí.
export async function alignOrderMoves(odooOrderId, lines) {
  const odooLineIds = lines.map((l) => l.odooLineId).filter(Boolean);
  if (!odooLineIds.length) return [];
  const moves = await callKwReadWithRetry('stock.move', 'search_read', [
    [['sale_line_id', 'in', odooLineIds], ['state', 'not in', ['done', 'cancel']]],
  ], { fields: ['id', 'sale_line_id', 'location_id', 'picking_id', 'state'] });
  const plan = planMoveLocations(moves, lines, deliveryLocationId);
  if (!plan.length) return [];
  const pickingIds = [...new Set(plan.map((p) => p.pickingId).filter(Boolean))];
  await ensureAuth();
  if (pickingIds.length) await callKw('stock.picking', 'do_unreserve', [pickingIds]);
  for (const { moveId, locationId } of plan) {
    await callKw('stock.move', 'write', [[moveId], { location_id: locationId }]);
  }
  if (pickingIds.length) await callKw('stock.picking', 'action_assign', [pickingIds]);
  return plan;
}

// Antes de confirmar: Fallados con stock suficiente para las líneas de falla.
export function prepareFalladosStock(lines) {
  return ensureFalladosStock(lines
    .filter((l) => l.status !== 'eliminado' && l.location === FALLADOS)
    .map((l) => ({ sku: l.sku, qty: l.qty })));
}

// Después de confirmar: el remito desde la ubicación real de cada línea.
export function placeOrderStock(odooOrderId, lines) {
  return alignOrderMoves(odooOrderId, lines.filter((l) => l.status !== 'eliminado'));
}
