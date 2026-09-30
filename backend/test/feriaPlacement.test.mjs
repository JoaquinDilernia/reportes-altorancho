import { test } from 'node:test';
import assert from 'node:assert/strict';
import { falladosTopUpDelta, planMoveLocations } from '../feriaPlacement.mjs';

test('falladosTopUpDelta: Fallados sin stock queda en 100', () => {
  assert.equal(falladosTopUpDelta({ falladosQty: 0, freeQty: 0, required: 1 }), 100);
  assert.equal(falladosTopUpDelta({ falladosQty: -2, freeQty: -2, required: 2 }), 102);
});

test('falladosTopUpDelta: si el libre del almacén no alcanza, suma lo que falta + 100', () => {
  assert.equal(falladosTopUpDelta({ falladosQty: 100, freeQty: 5, required: 6 }), 101);
});

test('falladosTopUpDelta: con stock suficiente no toca nada', () => {
  assert.equal(falladosTopUpDelta({ falladosQty: 100, freeQty: 100, required: 6 }), 0);
});

const LOC = { fallados: 429, exhibicion: 427, rolon: 419 };

test('planMoveLocations: apunta cada movimiento abierto a la ubicación de su línea', () => {
  const moves = [
    { id: 10, sale_line_id: [1, 'x'], location_id: [419, 'FER/Stock'], picking_id: [7, 'OUT'], state: 'confirmed' },
    { id: 11, sale_line_id: [2, 'x'], location_id: [427, 'exhib'], picking_id: [7, 'OUT'], state: 'assigned' },
    { id: 12, sale_line_id: [3, 'x'], location_id: [419, 'FER/Stock'], picking_id: [7, 'OUT'], state: 'done' },
  ];
  const lines = [
    { odooLineId: 1, location: 'fallados' },
    { odooLineId: 2, location: 'exhibicion' },
    { odooLineId: 3, location: 'fallados' },
    { location: 'rolon' },
  ];
  assert.deepEqual(planMoveLocations(moves, lines, (l) => LOC[l]), [{ moveId: 10, pickingId: 7, locationId: 429 }]);
});
