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

// Decide qué escribir en las stock.move.line para que al validar salga
// EXACTAMENTE lo pedido (cantidad y ubicación de origen) y nada más.
// Puro para poder testearlo sin Odoo.
export function planMoveLineWrites({ moves, moveLines, items, openPickingIds }) {
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
    const atLocation = moveLines.find((ml) => ml.move_id[0] === openMove.id && ml.location_id[0] === item.locationId);
    if (atLocation) {
      writes.push({ id: atLocation.id, vals: { qty_done: item.qty } });
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
export async function deliverLines(odooOrderId, items) {
  const pickings = await callKwReadWithRetry('stock.picking', 'search_read', [
    [['sale_id', '=', odooOrderId], ['state', 'not in', ['done', 'cancel']], ['picking_type_code', '=', 'outgoing']],
  ], { fields: ['id'] });
  const openPickingIds = pickings.map((p) => p.id);

  const moves = await callKwReadWithRetry('stock.move', 'search_read', [
    [['sale_line_id', 'in', items.map((i) => i.odooLineId)], ['state', '!=', 'cancel']],
  ], { fields: ['id', 'sale_line_id', 'picking_id', 'product_id', 'product_uom', 'location_dest_id', 'state'] });

  const moveLines = openPickingIds.length
    ? await callKwReadWithRetry('stock.move.line', 'search_read', [
      [['picking_id', 'in', openPickingIds]],
    ], { fields: ['id', 'move_id', 'location_id', 'qty_done'] })
    : [];

  const plan = planMoveLineWrites({ moves, moveLines, items, openPickingIds });
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

  const alreadyDone = new Set(plan.alreadyDone);
  return {
    delivered: items.map((i) => i.odooLineId).filter((id) => !alreadyDone.has(id)),
    alreadyDone: plan.alreadyDone,
  };
}
