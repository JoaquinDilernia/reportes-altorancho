import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuDomain, sumQuantsBySku, availabilityFor, checkAvailability, nextReserved } from '../feriaStock.mjs';

const ids = { exhibicion: 427, rolon: 428 };

test('skuDomain arma un OR de =ilike (Odoo puede tener default_code en minúsculas)', () => {
  assert.deepEqual(skuDomain(['A']), [['product_id.default_code', '=ilike', 'A']]);
  assert.deepEqual(skuDomain(['A', 'B', 'C']), [
    '|', '|',
    ['product_id.default_code', '=ilike', 'A'],
    ['product_id.default_code', '=ilike', 'B'],
    ['product_id.default_code', '=ilike', 'C'],
  ]);
});

test('sumQuantsBySku suma por SKU (en mayúsculas) y ubicación', () => {
  const quants = [
    { product_id: [1, '[alf029cg] FELPUDO'], location_id: [427, 'FER/Stock/exhibicion'], quantity: 2 },
    { product_id: [1, '[ALF029CG] FELPUDO'], location_id: [427, 'FER/Stock/exhibicion'], quantity: 1 },
    { product_id: [1, '[ALF029CG] FELPUDO'], location_id: [428, 'FER/Stock/Rolon'], quantity: 5 },
  ];
  assert.deepEqual(sumQuantsBySku(quants, ids).get('ALF029CG'), { exhibicion: 3, rolon: 5 });
});

test('availabilityFor resta lo reservado y nunca da negativo', () => {
  const odoo = new Map([['ALF029CG', { exhibicion: 3, rolon: 1 }]]);
  const reserved = new Map([['ALF029CG__exhibicion', 1], ['ALF029CG__rolon', 4]]);
  assert.deepEqual(availabilityFor(odoo, reserved, 'ALF029CG'), { exhibicion: 2, rolon: 0 });
  assert.deepEqual(availabilityFor(odoo, reserved, 'NOEXISTE'), { exhibicion: 0, rolon: 0 });
});

test('checkAvailability rechaza si dos líneas del mismo SKU+ubicación superan el disponible', () => {
  const odoo = new Map([['ALF029CG', { exhibicion: 1, rolon: 0 }]]);
  const errors = checkAvailability(odoo, new Map(), new Map([['ALF029CG__exhibicion', 2]]));
  assert.deepEqual(errors, ['ALF029CG en Exhibición: pediste 2, hay 1']);
});

test('checkAvailability descuenta lo ya reservado por otros pedidos', () => {
  const odoo = new Map([['ALF029CG', { exhibicion: 3, rolon: 0 }]]);
  const reserved = new Map([['ALF029CG__exhibicion', 3]]);
  assert.equal(checkAvailability(odoo, reserved, new Map([['ALF029CG__exhibicion', 1]])).length, 1);
});

test('checkAvailability nunca bloquea liberar reserva (deltas negativos)', () => {
  const odoo = new Map([['ALF029CG', { exhibicion: 0, rolon: 0 }]]);
  assert.deepEqual(checkAvailability(odoo, new Map([['ALF029CG__exhibicion', 1]]), new Map([['ALF029CG__exhibicion', -1]])), []);
});

test('checkAvailability al mover de ubicación solo exige stock en la nueva', () => {
  const odoo = new Map([['ALF029CG', { exhibicion: 1, rolon: 0 }]]);
  const deltas = new Map([['ALF029CG__exhibicion', -1], ['ALF029CG__rolon', 1]]);
  assert.deepEqual(checkAvailability(odoo, new Map([['ALF029CG__exhibicion', 1]]), deltas), ['ALF029CG en Rolón: pediste 1, hay 0']);
});

test('nextReserved aplica los deltas sin bajar de 0', () => {
  const next = nextReserved(new Map([['A__rolon', 1]]), new Map([['A__rolon', -3], ['B__exhibicion', 2]]));
  assert.deepEqual([...next], [['A__rolon', 0], ['B__exhibicion', 2]]);
});
