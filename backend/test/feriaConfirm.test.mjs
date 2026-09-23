import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOdooLines, pairOdooLineIds } from '../feriaConfirm.mjs';

const lines = [
  { lineId: 'L1', sku: 'A', qty: 1, listPrice: 9990, unitPrice: 7992, delivery: 'ahora', status: 'pendiente' },
  { lineId: 'L3', sku: 'B', qty: 2, listPrice: 10000, unitPrice: 8000, delivery: 'envio', status: 'pendiente' },
];

test('buildOdooLines: precios sin IVA con descuento del medio de pago + línea de envío sin descuento', () => {
  assert.deepEqual(buildOdooLines(lines, 'transferencia', [501, 502], 9759), [
    { productId: 501, qty: 1, unitPrice: 8256.2, discountPct: 15 },
    { productId: 502, qty: 2, unitPrice: 8264.46, discountPct: 15 },
    { productId: 9759, qty: 1, unitPrice: 8264.46, discountPct: 0 },
  ]);
});

test('buildOdooLines sin producto de envío no agrega la línea', () => {
  assert.equal(buildOdooLines(lines.slice(0, 1), 'efectivo', [501], null).length, 1);
});

test('pairOdooLineIds empareja en orden e ignora la línea de envío que queda al final', () => {
  assert.deepEqual(pairOdooLineIds(lines, [11, 12, 13]), { L1: 11, L3: 12 });
});

test('pairOdooLineIds falla si Odoo devolvió menos líneas de las esperadas', () => {
  assert.throws(() => pairOdooLineIds(lines, [11]), /Odoo devolvió 1 líneas/);
});
