import { test } from 'node:test';
import assert from 'node:assert/strict';
import { falladosToTopUp, planMoveLocations } from '../feriaPlacement.mjs';

test('falladosToTopUp: productos sin stock o en negativo en Fallados (suma de todos sus quants)', () => {
  const quants = [
    { product_id: [1, 'a'], quantity: 100 },
    { product_id: [2, 'b'], quantity: 0 },
    { product_id: [3, 'c'], quantity: -2 },
    { product_id: [3, 'c'], quantity: 1 },
  ];
  // 4 no tiene ningún quant en Fallados: también se carga.
  assert.deepEqual(falladosToTopUp([1, 2, 3, 4], quants), [2, 3, 4]);
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
