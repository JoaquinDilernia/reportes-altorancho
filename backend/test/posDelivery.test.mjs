import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutLegWrites, validateTwoStep } from '../posDelivery.mjs';

const ml = (id, moveId, pickingId, reserved, done = 0) => ({
  id, move_id: [moveId, 'x'], picking_id: [pickingId, 'x'], reserved_uom_qty: reserved, qty_done: done,
});

test('planOutLegWrites: hecho = reservado en las del pedido; el resto en 0; valida solo esos OUT', () => {
  const plan = planOutLegWrites([
    ml(1, 11, 900, 2), ml(2, 11, 900, 1), ml(3, 99, 900, 1, 1), ml(4, 98, 901, 1, 0), ml(5, 12, 902, 1, 1),
  ], [11, 12]);
  assert.deepEqual(plan.writes, [
    { id: 1, vals: { qty_done: 2 } }, { id: 2, vals: { qty_done: 1 } }, { id: 3, vals: { qty_done: 0 } },
  ]);
  assert.deepEqual(plan.pickingIdsToValidate, [900, 902]);
  assert.deepEqual(plan.unreserved, []);
});

test('planOutLegWrites: un move del pedido sin reserva en el OUT queda en unreserved', () => {
  const plan = planOutLegWrites([ml(1, 11, 900, 0)], [11, 12]);
  assert.deepEqual(plan.unreserved, [11, 12]);
});

// Odoo falso con estado: PICK 800 (move 21) → OUT 900 (move 11, línea 71).
function fakeOdoo({ validateResult = true, outDoneAtEnd = true } = {}) {
  const state = { pickDone: false, outDone: false };
  const calls = [];
  const pickMove = () => ({
    id: 21, sale_line_id: false, move_orig_ids: [], picking_id: [800, 'LL/PICK'], product_id: [5, 'P'], product_uom: [1, 'u'],
    location_id: [8, 'LL/Stock'], location_dest_id: [11, 'LL/Salida'], state: state.pickDone ? 'done' : 'assigned',
  });
  const outMove = () => ({
    id: 11, sale_line_id: [71, 'x'], move_orig_ids: [21], picking_id: [900, 'LL/OUT'], product_id: [5, 'P'], product_uom: [1, 'u'],
    location_id: [11, 'LL/Salida'], location_dest_id: [5, 'Clientes'],
    state: state.outDone && outDoneAtEnd ? 'done' : state.pickDone ? 'assigned' : 'waiting',
  });
  const odoo = {
    read: async (model, method, args) => {
      calls.push(['read', model, method, args]);
      if (model === 'stock.move' && method === 'search_read') return [outMove()];
      if (model === 'stock.move' && method === 'read') return [pickMove()];
      if (model === 'stock.picking') {
        return [
          ...(state.pickDone ? [] : [{ id: 800, picking_type_code: 'internal' }]),
          ...(state.outDone ? [] : [{ id: 900, picking_type_code: 'outgoing' }]),
        ];
      }
      if (model === 'stock.move.line') {
        const pickingIds = args[0][0][2];
        if (pickingIds.includes(800)) return [{ id: 1, move_id: [21, 'x'], picking_id: [800, 'x'], location_id: [8, 'x'], lot_id: [3, 'L'], qty_done: 0 }];
        return [ml(2, 11, 900, 1), ml(3, 99, 900, 1, 1)];
      }
      return [];
    },
    write: async (model, method, args, kwargs) => {
      calls.push(['write', model, method, args, kwargs]);
      if (method === 'button_validate') {
        if (validateResult !== true) return validateResult;
        if (args[0][0] === 800) state.pickDone = true;
        if (args[0][0] === 900) state.outDone = true;
      }
      return true;
    },
  };
  return { odoo, calls };
}

const items = [{ odooLineId: 71, qty: 1, locationId: 8 }];

test('validateTwoStep: valida el PICK con lo pedido y después el OUT con lo reservado', async () => {
  const { odoo, calls } = fakeOdoo();
  const result = await validateTwoStep(5000, items, odoo);
  assert.deepEqual(result, { delivered: [71] });
  const writes = calls.filter((c) => c[0] === 'write').map((c) => [c[1], c[2], c[3]]);
  assert.deepEqual(writes, [
    ['stock.move.line', 'write', [[1], { qty_done: 1 }]],
    ['stock.picking', 'button_validate', [[800]]],
    ['stock.picking', 'action_assign', [[900]]],
    ['stock.move.line', 'write', [[2], { qty_done: 1 }]],
    ['stock.move.line', 'write', [[3], { qty_done: 0 }]],
    ['stock.picking', 'button_validate', [[900]]],
  ]);
  const validate = calls.find((c) => c[2] === 'button_validate');
  assert.equal(validate[4].context.skip_backorder, true);
});

test('validateTwoStep: si Odoo pide un asistente al validar, falla con mensaje claro', async () => {
  const { odoo } = fakeOdoo({ validateResult: { res_model: 'stock.backorder.confirmation' } });
  await assert.rejects(validateTwoStep(5001, items, odoo), /confirmación manual \(stock\.backorder\.confirmation\)/);
});

test('validateTwoStep: si después de validar la línea no quedó hecha, falla', async () => {
  const { odoo } = fakeOdoo({ outDoneAtEnd: false });
  await assert.rejects(validateTwoStep(5002, items, odoo), /no registró la entrega de las líneas 71/);
});
