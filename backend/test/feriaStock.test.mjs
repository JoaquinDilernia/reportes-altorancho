import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuDomain, sumQuantsBySku, availabilityFor } from '../feriaStock.mjs';

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
