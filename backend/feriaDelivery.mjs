import { callKw } from './odoo.mjs';
import { ensureAuth, callKwReadWithRetry } from './feriaOdoo.mjs';

// Contexto para validar un remito sin abrir asistentes: el usuario de la API
// no tiene acceso a stock.backorder.confirmation ni a
// stock.immediate.transfer. En Odoo 16, con skip_backorder (y sin
// picking_ids_not_to_backorder) button_validate valida lo marcado como hecho
// y crea el remito pendiente (backorder) con el resto, sin preguntar.
const VALIDATE_CONTEXT = {
  lang: 'es_AR', skip_backorder: true, skip_immediate: true, skip_sms: true, skip_expired: true,
};

const lotKey = (productId, locationId) => `${productId}:${locationId}`;

// Dos "Hecho" casi simultáneos sobre el mismo pedido se pisan en Odoo: el
// segundo pone en 0 la cantidad hecha que cargó el primero antes de que éste
// valide, y el primero termina "validando" nada. Se encolan por pedido (un
// solo proceso en Railway, así que alcanza con una cola en memoria).
const orderQueues = new Map();

export function withOrderLock(key, fn) {
  const previous = orderQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  orderQueues.set(key, tail);
  tail.then(() => { if (orderQueues.get(key) === tail) orderQueues.delete(key); });
  return run;
}

// Después de validar, una línea está entregada si tiene un movimiento hecho y
// ninguno abierto (si quedó algo en el backorder, no salió).
export function undeliveredLineIds(moves, odooLineIds) {
  return odooLineIds.filter((id) => {
    const forLine = moves.filter((m) => m.sale_line_id?.[0] === id && m.state !== 'cancel');
    return !forLine.some((m) => m.state === 'done') || forLine.some((m) => m.state !== 'done');
  });
}

// Muchos productos se controlan por lote en Odoo (tracking 'lot'): validar
// una move line sin lote falla con "Debe proporcionar un número de lote".
// Por producto+ubicación se toma el lote con más stock ahí.
export function pickLots(quants) {
  const best = new Map();
  for (const q of quants) {
    if (!q.lot_id) continue;
    const key = lotKey(q.product_id[0], q.location_id[0]);
    if (!best.has(key) || q.quantity > best.get(key).quantity) best.set(key, { lotId: q.lot_id[0], quantity: q.quantity });
  }
  return new Map([...best].map(([key, { lotId }]) => [key, lotId]));
}

// Fallados tiene stock ficticio: sus productos con lote casi nunca tienen un
// lote con stock ahí, y sin lote Odoo no deja validar la entrega. Para esos se
// usa un lote fijo por producto (puede quedar en negativo), así la falla se
// entrega siempre. Devuelve los productId que lo necesitan. Puro.
export const FALLADO_LOT_NAME = 'FALLADO';

export function productsNeedingFalladoLot({ moves, items, lots, tracking, falladosLocationId }) {
  if (!falladosLocationId) return [];
  const needed = new Set();
  for (const item of items) {
    if (item.locationId !== falladosLocationId) continue;
    const move = moves.find((m) => m.sale_line_id?.[0] === item.odooLineId && m.state !== 'cancel' && m.state !== 'done');
    if (!move) continue;
    const productId = move.product_id[0];
    if ((tracking.get(productId) ?? 'none') === 'none') continue;
    if (lots.has(lotKey(productId, item.locationId))) continue;
    needed.add(productId);
  }
  return [...needed];
}

// Lote FALLADO de cada producto: el existente o uno nuevo.
export async function ensureFalladoLots(productIds, companyId) {
  const existing = await callKwReadWithRetry('stock.lot', 'search_read', [
    [['product_id', 'in', productIds], ['name', '=', FALLADO_LOT_NAME]],
  ], { fields: ['id', 'product_id'] });
  const byProduct = new Map(existing.map((l) => [l.product_id[0], l.id]));
  await ensureAuth();
  for (const productId of productIds) {
    if (byProduct.has(productId)) continue;
    const [id] = await callKw('stock.lot', 'create', [[{
      name: FALLADO_LOT_NAME, product_id: productId, ...(companyId ? { company_id: companyId } : {}),
    }]]);
    byProduct.set(productId, id);
  }
  return byProduct;
}

// Decide qué escribir en las stock.move.line para que al validar salga
// EXACTAMENTE lo pedido (cantidad y ubicación de origen) y nada más.
// `lots` (de pickLots) trae el lote a usar para productos con lote.
// Puro para poder testearlo sin Odoo.
export function planMoveLineWrites({ moves, moveLines, items, openPickingIds, lots = new Map() }) {
  const open = new Set(openPickingIds);
  const writes = [];
  const creates = [];
  const alreadyDone = [];
  const missing = [];
  const pickingIds = new Set();
  const targetedMoveLineIds = new Set();

  for (const item of items) {
    const forLine = moves.filter((m) => m.sale_line_id?.[0] === item.odooLineId && m.state !== 'cancel');
    const openMove = forLine.find((m) => m.state !== 'done' && open.has(m.picking_id?.[0]));
    if (!openMove) {
      if (forLine.some((m) => m.state === 'done')) alreadyDone.push(item.odooLineId);
      else missing.push(item.odooLineId);
      continue;
    }
    pickingIds.add(openMove.picking_id[0]);
    const lotId = lots.get(lotKey(openMove.product_id[0], item.locationId));
    const atLocation = moveLines.find((ml) => ml.move_id[0] === openMove.id && ml.location_id[0] === item.locationId);
    if (atLocation) {
      const vals = { qty_done: item.qty };
      if (lotId && !atLocation.lot_id) vals.lot_id = lotId;
      writes.push({ id: atLocation.id, vals });
      targetedMoveLineIds.add(atLocation.id);
    } else {
      creates.push({
        move_id: openMove.id,
        picking_id: openMove.picking_id[0],
        product_id: openMove.product_id[0],
        product_uom_id: openMove.product_uom[0],
        location_id: item.locationId,
        location_dest_id: openMove.location_dest_id[0],
        qty_done: item.qty,
        ...(lotId ? { lot_id: lotId } : {}),
      });
    }
  }

  // Cualquier qty_done que haya quedado de antes (alguien tocó el remito a
  // mano, o un intento anterior cortado) saldría validada junto con esto.
  for (const ml of moveLines) {
    if (!targetedMoveLineIds.has(ml.id) && ml.qty_done > 0) writes.push({ id: ml.id, vals: { qty_done: 0 } });
  }

  return { writes, creates, pickingIdsToValidate: [...pickingIds], alreadyDone, missing };
}

// Marca como entregadas (salida al cliente) esas líneas del pedido de Odoo,
// desde la ubicación indicada, y valida el remito. Lo no incluido queda en el
// remito pendiente. Es seguro llamarla de nuevo: lo que ya estaba hecho
// vuelve en alreadyDone en vez de fallar.
export function deliverLines(odooOrderId, items) {
  return withOrderLock(odooOrderId, () => deliverLinesNow(odooOrderId, items));
}

async function deliverLinesNow(odooOrderId, items) {
  const pickings = await callKwReadWithRetry('stock.picking', 'search_read', [
    [['sale_id', '=', odooOrderId], ['state', 'not in', ['done', 'cancel']], ['picking_type_code', '=', 'outgoing']],
  ], { fields: ['id'] });
  const openPickingIds = pickings.map((p) => p.id);

  const moves = await callKwReadWithRetry('stock.move', 'search_read', [
    [['sale_line_id', 'in', items.map((i) => i.odooLineId)], ['state', '!=', 'cancel']],
  ], { fields: ['id', 'sale_line_id', 'picking_id', 'product_id', 'product_uom', 'location_dest_id', 'state', 'company_id'] });

  const moveLines = openPickingIds.length
    ? await callKwReadWithRetry('stock.move.line', 'search_read', [
      [['picking_id', 'in', openPickingIds]],
    ], { fields: ['id', 'move_id', 'location_id', 'lot_id', 'qty_done'] })
    : [];

  // Lotes con stock en las ubicaciones pedidas (los productos sin lote no
  // tienen quants con lot_id, así que no aparecen y no llevan lote).
  const productIds = [...new Set(moves.map((m) => m.product_id[0]))];
  const locationIds = [...new Set(items.map((i) => i.locationId))];
  const lotQuants = productIds.length
    ? await callKwReadWithRetry('stock.quant', 'search_read', [
      [['product_id', 'in', productIds], ['location_id', 'in', locationIds], ['lot_id', '!=', false], ['quantity', '>', 0]],
    ], { fields: ['product_id', 'location_id', 'lot_id', 'quantity'] })
    : [];

  const lots = pickLots(lotQuants);
  const falladosLocationId = Number(process.env.ODOO_FERIA_LOCATION_FALLADOS_ID) || null;
  if (falladosLocationId && items.some((i) => i.locationId === falladosLocationId) && productIds.length) {
    const products = await callKwReadWithRetry('product.product', 'read', [productIds], { fields: ['tracking'] });
    const tracking = new Map(products.map((p) => [p.id, p.tracking]));
    const needLot = productsNeedingFalladoLot({ moves, items, lots, tracking, falladosLocationId });
    if (needLot.length) {
      const companyId = moves.find((m) => m.company_id)?.company_id?.[0];
      const falladoLots = await ensureFalladoLots(needLot, companyId);
      for (const [productId, lotId] of falladoLots) lots.set(lotKey(productId, falladosLocationId), lotId);
    }
  }

  const plan = planMoveLineWrites({ moves, moveLines, items, openPickingIds, lots });
  if (plan.missing.length) {
    throw new Error(`Líneas sin remito abierto en Odoo: ${plan.missing.join(', ')}`);
  }

  await ensureAuth();
  for (const w of plan.writes) await callKw('stock.move.line', 'write', [[w.id], w.vals]);
  for (const vals of plan.creates) await callKw('stock.move.line', 'create', [[vals]]);
  for (const pickingId of plan.pickingIdsToValidate) {
    const result = await callKw('stock.picking', 'button_validate', [[pickingId]], { context: VALIDATE_CONTEXT });
    if (result !== true && result?.res_model) {
      throw new Error(`Odoo pidió confirmación manual (${result.res_model}) al validar el remito ${pickingId}`);
    }
  }

  // Se verifica en Odoo que las líneas salieron de verdad antes de que la app
  // las marque entregadas y libere la reserva: cualquier carrera o cambio a
  // mano en el remito termina en un error visible y no en stock inventado.
  const after = await callKwReadWithRetry('stock.move', 'search_read', [
    [['sale_line_id', 'in', items.map((i) => i.odooLineId)], ['state', '!=', 'cancel']],
  ], { fields: ['id', 'sale_line_id', 'state'] });
  const notDelivered = undeliveredLineIds(after, items.map((i) => i.odooLineId));
  if (notDelivered.length) {
    throw new Error(`Odoo no registró la entrega de las líneas ${notDelivered.join(', ')} — revisá el remito y reintentá`);
  }

  const alreadyDone = new Set(plan.alreadyDone);
  return {
    delivered: items.map((i) => i.odooLineId).filter((id) => !alreadyDone.has(id)),
    alreadyDone: plan.alreadyDone,
  };
}
