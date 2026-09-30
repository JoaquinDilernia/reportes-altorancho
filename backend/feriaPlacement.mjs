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

// Productos sin stock (≤ 0) en Fallados, sumando todos sus quants. Puro.
export function falladosToTopUp(productIds, quants) {
  const total = new Map(productIds.map((id) => [id, 0]));
  for (const q of quants) {
    const id = q.product_id[0];
    if (total.has(id)) total.set(id, total.get(id) + q.quantity);
  }
  return [...total].filter(([, qty]) => qty <= 0).map(([id]) => id);
}

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

// Falla sin stock en Fallados → FALLADOS_TOPUP unidades.
export async function ensureFalladosStock(skus) {
  const falladosId = Number(process.env.ODOO_FERIA_LOCATION_FALLADOS_ID);
  if (!falladosId || !skus.length) return [];
  const productIds = [];
  for (const sku of new Set(skus)) {
    const id = await findProductIdBySku(sku);
    if (id) productIds.push(id);
  }
  if (!productIds.length) return [];
  const quants = await callKwReadWithRetry('stock.quant', 'search_read', [
    [['product_id', 'in', productIds], ['location_id', '=', falladosId]],
  ], { fields: ['product_id', 'quantity'] });
  const toTopUp = falladosToTopUp(productIds, quants);
  if (!toTopUp.length) return [];

  const products = await callKwReadWithRetry('product.product', 'read', [toTopUp], { fields: ['tracking', 'company_id'] });
  const tracked = products.filter((p) => p.tracking !== 'none');
  await ensureAuth();
  const lots = tracked.length ? await ensureFalladoLots(tracked.map((p) => p.id), tracked[0].company_id?.[0]) : new Map();
  for (const p of products) {
    await setQuantTo(p.id, falladosId, p.tracking !== 'none' ? lots.get(p.id) : null, FALLADOS_TOPUP);
  }
  console.log(`[feriaPlacement] Fallados: ${toTopUp.length} producto(s) sin stock cargados con ${FALLADOS_TOPUP}`);
  return toTopUp;
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

// Los dos pasos juntos, para una venta ya confirmada en Odoo.
export async function placeOrderStock(odooOrderId, lines) {
  const active = lines.filter((l) => l.status !== 'eliminado');
  await ensureFalladosStock(active.filter((l) => l.location === FALLADOS).map((l) => l.sku));
  return alignOrderMoves(odooOrderId, active);
}
