// "Se lo lleva ahora" en un almacén de 2 pasos (todos los locales, spike
// S1b): al confirmar se valida el PICK (Stock/Exhibición → Salida) y después
// el OUT (Salida → Cliente) solo de esas líneas; el resto queda en los
// remitos pendientes (backorder) para logística. Reusa los planificadores
// puros de la feria (feriaDelivery no se modifica).
import { withOrderLock, pickLots, planMoveLineWrites, undeliveredLineIds } from './feriaDelivery.mjs';
import { defaultOdoo, readLegMoves } from './posOdoo.mjs';

// Mismo contexto que la feria: validar sin asistentes y dejar backorder.
const VALIDATE_CONTEXT = {
  lang: 'es_AR', skip_backorder: true, skip_immediate: true, skip_sms: true, skip_expired: true,
};

// OUT: el lote y la cantidad vienen del PICK, así que en las move lines de
// las líneas del pedido el hecho es lo reservado; cualquier otro hecho del
// remito se pone en 0 (saldría validado junto con esto). Puro.
export function planOutLegWrites(moveLines, targetMoveIds) {
  const targets = new Set(targetMoveIds);
  const writes = [];
  const pickingIds = new Set();
  const reserved = new Set();
  for (const line of moveLines) {
    const moveId = line.move_id?.[0];
    if (targets.has(moveId)) {
      const qty = line.reserved_uom_qty ?? 0;
      if (qty > 0) {
        reserved.add(moveId);
        pickingIds.add(line.picking_id[0]);
      }
      if (line.qty_done !== qty) writes.push({ id: line.id, vals: { qty_done: qty } });
    } else if (line.qty_done > 0) {
      writes.push({ id: line.id, vals: { qty_done: 0 } });
    }
  }
  return {
    writes, pickingIdsToValidate: [...pickingIds], unreserved: targetMoveIds.filter((id) => !reserved.has(id)),
  };
}

async function validatePickings(odoo, pickingIds) {
  for (const pickingId of pickingIds) {
    const result = await odoo.write('stock.picking', 'button_validate', [[pickingId]], { context: VALIDATE_CONTEXT });
    if (result !== true && result?.res_model) {
      throw new Error(`Odoo pidió confirmación manual (${result.res_model}) al validar el remito ${pickingId}`);
    }
  }
}

const openPickingsOf = (odoo, odooOrderId) => odoo.read('stock.picking', 'search_read', [[
  ['sale_id', '=', odooOrderId], ['state', 'not in', ['done', 'cancel']],
]], { fields: ['id', 'picking_type_code'] });

// `items`: [{ odooLineId, qty, locationId }] (locationId = Stock o Exhibición
// exacta). Es seguro llamarla de nuevo: lo que ya estaba hecho no se repite.
export function validateTwoStep(odooOrderId, items, odoo = defaultOdoo) {
  return withOrderLock(odooOrderId, () => validateTwoStepNow(odooOrderId, items, odoo));
}

async function validateTwoStepNow(odooOrderId, items, odoo) {
  const lineIds = items.map((i) => i.odooLineId);

  // 1. PICK: lo pedido desde su ubicación exacta (planificador de la feria
  // sobre los moves del primer tramo).
  const { firstLeg } = await readLegMoves(lineIds, odoo);
  const open = await openPickingsOf(odoo, odooOrderId);
  const firstLegPickingIds = open.filter((p) => firstLeg.some((m) => m.picking_id?.[0] === p.id)).map((p) => p.id);
  const moveLines = firstLegPickingIds.length
    ? await odoo.read('stock.move.line', 'search_read', [[['picking_id', 'in', firstLegPickingIds]]], {
      fields: ['id', 'move_id', 'picking_id', 'location_id', 'lot_id', 'qty_done'],
    })
    : [];
  const productIds = [...new Set(firstLeg.map((m) => m.product_id[0]))];
  const locationIds = [...new Set(items.map((i) => i.locationId))];
  const lotQuants = productIds.length
    ? await odoo.read('stock.quant', 'search_read', [[
      ['product_id', 'in', productIds], ['location_id', 'in', locationIds], ['lot_id', '!=', false], ['quantity', '>', 0],
    ]], { fields: ['product_id', 'location_id', 'lot_id', 'quantity'] })
    : [];
  const pick = planMoveLineWrites({ moves: firstLeg, moveLines, items, openPickingIds: firstLegPickingIds, lots: pickLots(lotQuants) });
  if (pick.missing.length) throw new Error(`Líneas sin PICK abierto en Odoo: ${pick.missing.join(', ')}`);
  for (const w of pick.writes) await odoo.write('stock.move.line', 'write', [[w.id], w.vals]);
  for (const vals of pick.creates) await odoo.write('stock.move.line', 'create', [[vals]]);
  await validatePickings(odoo, pick.pickingIdsToValidate);

  // 2. OUT: se reserva lo que llegó a Salida y se valida eso.
  const { lineMoves } = await readLegMoves(lineIds, odoo);
  const outPickingIds = new Set((await openPickingsOf(odoo, odooOrderId))
    .filter((p) => p.picking_type_code === 'outgoing').map((p) => p.id));
  const targets = lineMoves.filter((m) => m.move_orig_ids?.length && !['done', 'cancel'].includes(m.state)
    && outPickingIds.has(m.picking_id?.[0]));
  if (targets.length) {
    const pickingIds = [...new Set(targets.map((m) => m.picking_id[0]))];
    await odoo.write('stock.picking', 'action_assign', [pickingIds]);
    const outLines = await odoo.read('stock.move.line', 'search_read', [[['picking_id', 'in', pickingIds]]], {
      fields: ['id', 'move_id', 'picking_id', 'reserved_uom_qty', 'qty_done'],
    });
    const out = planOutLegWrites(outLines, targets.map((m) => m.id));
    if (out.unreserved.length) {
      throw new Error(`El OUT no quedó reservado después del PICK (moves ${out.unreserved.join(', ')})`);
    }
    for (const w of out.writes) await odoo.write('stock.move.line', 'write', [[w.id], w.vals]);
    await validatePickings(odoo, out.pickingIdsToValidate);
  }

  // 3. Se verifica en Odoo que las líneas salieron (moves con sale_line_id:
  // los del OUT) antes de que la app las marque entregadas.
  const after = await odoo.read('stock.move', 'search_read', [[
    ['sale_line_id', 'in', lineIds], ['state', '!=', 'cancel'],
  ]], { fields: ['id', 'sale_line_id', 'state'] });
  const notDelivered = undeliveredLineIds(after, lineIds);
  if (notDelivered.length) {
    throw new Error(`Odoo no registró la entrega de las líneas ${notDelivered.join(', ')} — revisá PICK y OUT en Odoo`);
  }
  return { delivered: lineIds };
}
