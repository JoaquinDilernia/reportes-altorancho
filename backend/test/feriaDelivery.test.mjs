import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMoveLineWrites, pickLots } from '../feriaDelivery.mjs';

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

test('producto con lote: la move line creada lleva el lote que tiene stock en esa ubicación', () => {
  const lots = new Map([['501:427', 21887]]);
  const plan = planMoveLineWrites({ moves, moveLines, items: [{ odooLineId: 11, qty: 1, locationId: EXHIB }], openPickingIds: [900], lots });
  assert.equal(plan.creates[0].lot_id, 21887);
});

test('producto con lote: si la move line de esa ubicación no tiene lote, se lo agrega', () => {
  const lots = new Map([['502:427', 555]]);
  const noLot = [{ ...moveLines[1], lot_id: false }];
  const plan = planMoveLineWrites({ moves, moveLines: noLot, items: [{ odooLineId: 12, qty: 1, locationId: EXHIB }], openPickingIds: [900], lots });
  assert.deepEqual(plan.writes, [{ id: 102, vals: { qty_done: 1, lot_id: 555 } }]);
});

test('producto con lote: una move line que ya tiene lote lo conserva', () => {
  const lots = new Map([['502:427', 555]]);
  const withLot = [{ ...moveLines[1], lot_id: [777, 'L-777'] }];
  const plan = planMoveLineWrites({ moves, moveLines: withLot, items: [{ odooLineId: 12, qty: 1, locationId: EXHIB }], openPickingIds: [900], lots });
  assert.deepEqual(plan.writes, [{ id: 102, vals: { qty_done: 1 } }]);
});

test('pickLots elige, por producto y ubicación, el lote con más stock', () => {
  const quants = [
    { product_id: [501, 'A'], location_id: [427, 'x'], lot_id: [1, 'L1'], quantity: 1 },
    { product_id: [501, 'A'], location_id: [427, 'x'], lot_id: [2, 'L2'], quantity: 4 },
    { product_id: [501, 'A'], location_id: [428, 'y'], lot_id: [3, 'L3'], quantity: 2 },
    { product_id: [502, 'B'], location_id: [427, 'x'], lot_id: false, quantity: 9 },
  ];
  assert.deepEqual([...pickLots(quants)], [['501:427', 2], ['501:428', 3]]);
});
