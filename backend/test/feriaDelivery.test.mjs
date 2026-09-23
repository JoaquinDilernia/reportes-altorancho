import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMoveLineWrites } from '../feriaDelivery.mjs';

const EXHIB = 427;
const ROLON = 428;

// Remito 900 abierto con dos movimientos: línea de venta 11 (reservada en
// Rolón por Odoo) y línea 12 (reservada en exhibición).
const moves = [
  { id: 1, sale_line_id: [11, 'x'], picking_id: [900, 'WH/OUT/1'], product_id: [501, 'A'], product_uom: [1, 'u'], location_dest_id: [5, 'Clientes'], state: 'assigned' },
  { id: 2, sale_line_id: [12, 'x'], picking_id: [900, 'WH/OUT/1'], product_id: [502, 'B'], product_uom: [1, 'u'], location_dest_id: [5, 'Clientes'], state: 'assigned' },
];
const moveLines = [
  { id: 101, move_id: [1, 'm'], location_id: [ROLON, 'Rolon'], qty_done: 0 },
  { id: 102, move_id: [2, 'm'], location_id: [EXHIB, 'exhib'], qty_done: 0 },
];

test('marca la cantidad hecha en la move line que ya está en la ubicación pedida', () => {
  const plan = planMoveLineWrites({ moves, moveLines, items: [{ odooLineId: 12, qty: 1, locationId: EXHIB }], openPickingIds: [900] });
  assert.deepEqual(plan.writes, [{ id: 102, vals: { qty_done: 1 } }]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.pickingIdsToValidate, [900]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.alreadyDone, []);
});

test('si Odoo reservó en otra ubicación, crea una move line en la ubicación pedida', () => {
  const plan = planMoveLineWrites({ moves, moveLines, items: [{ odooLineId: 11, qty: 1, locationId: EXHIB }], openPickingIds: [900] });
  assert.deepEqual(plan.creates, [{
    move_id: 1, picking_id: 900, product_id: 501, product_uom_id: 1,
    location_id: EXHIB, location_dest_id: 5, qty_done: 1,
  }]);
  assert.deepEqual(plan.writes, []);
});

test('pone en 0 cualquier qty_done previa que no corresponda a lo que se entrega', () => {
  const dirty = [
    { id: 101, move_id: [1, 'm'], location_id: [ROLON, 'Rolon'], qty_done: 1 },
    { id: 102, move_id: [2, 'm'], location_id: [EXHIB, 'exhib'], qty_done: 0 },
  ];
  const plan = planMoveLineWrites({ moves, moveLines: dirty, items: [{ odooLineId: 12, qty: 1, locationId: EXHIB }], openPickingIds: [900] });
  assert.deepEqual(plan.writes, [
    { id: 102, vals: { qty_done: 1 } },
    { id: 101, vals: { qty_done: 0 } },
  ]);
});

test('una línea cuyo movimiento ya está hecho vuelve como alreadyDone, no como error', () => {
  const doneMoves = [{ ...moves[0], state: 'done', picking_id: [899, 'WH/OUT/0'] }, moves[1]];
  const plan = planMoveLineWrites({ moves: doneMoves, moveLines, items: [{ odooLineId: 11, qty: 1, locationId: EXHIB }], openPickingIds: [900] });
  assert.deepEqual(plan.alreadyDone, [11]);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.pickingIdsToValidate, []);
});

test('una línea sin movimiento en ningún remito abierto vuelve como missing', () => {
  const plan = planMoveLineWrites({ moves, moveLines, items: [{ odooLineId: 99, qty: 1, locationId: EXHIB }], openPickingIds: [900] });
  assert.deepEqual(plan.missing, [99]);
});
