import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVariosLine, reservationDeltas, applyLineAction, repriceLines, VARIOS_SKU } from '../feriaLines.mjs';
import { buildOdooLines } from '../feriaConfirm.mjs';

const input = { description: '  Lámpara sin etiqueta ', listPrice: 20000, qty: 2 };

test('buildVariosLine: precio de lista a mano con el descuento del medio de pago, siempre "ahora" desde exhibición', () => {
  const line = buildVariosLine(input, 'efectivo', [{ lineId: 'L1' }]);
  assert.equal(line.lineId, 'L2');
  assert.equal(line.sku, VARIOS_SKU);
  assert.equal(line.description, 'Lámpara sin etiqueta');
  assert.equal(line.modelo, 'Lámpara sin etiqueta');
  assert.equal(line.listPrice, 20000);
  assert.equal(line.location, 'exhibicion');
  assert.equal(line.delivery, 'ahora');
  assert.equal(line.status, 'pendiente');
  assert.ok(line.unitPrice <= line.listPrice);
});

test('buildVariosLine: exige descripción, precio > 0 y cantidad entera', () => {
  assert.throws(() => buildVariosLine({ ...input, description: '  ' }, 'efectivo', []), /escribí qué se vende/);
  assert.throws(() => buildVariosLine({ ...input, listPrice: 0 }, 'efectivo', []), /mayor a 0/);
  assert.throws(() => buildVariosLine({ ...input, listPrice: '100' }, 'efectivo', []), /mayor a 0/);
  assert.throws(() => buildVariosLine({ ...input, qty: 1.5 }, 'efectivo', []), /cantidad/);
  assert.throws(() => buildVariosLine(input, 'bitcoin', []), /Medio de pago/);
});

test('Artículo varios no reserva stock', () => {
  const line = buildVariosLine(input, 'efectivo', []);
  assert.equal(reservationDeltas([], [line]).size, 0);
  assert.equal(reservationDeltas([line], []).size, 0);
});

test('Artículo varios: se puede cambiar la cantidad pero no la ubicación ni la entrega', () => {
  const line = buildVariosLine(input, 'efectivo', []);
  assert.equal(applyLineAction(line, 'edit', { user: 'c', now: 1, changes: { qty: 3 } }).qty, 3);
  assert.throws(() => applyLineAction(line, 'edit', { user: 'c', now: 1, changes: { location: 'rolon' } }), /Me llevo ahora/);
  assert.throws(() => applyLineAction(line, 'edit', { user: 'c', now: 1, changes: { delivery: 'retira_feria' } }), /Me llevo ahora/);
});

test('Artículo varios: al cambiar el medio de pago se recalcula desde el precio de lista', () => {
  const line = buildVariosLine(input, 'efectivo', []);
  const [again] = repriceLines([line], 'efectivo', 'efectivo');
  assert.equal(again.listPrice, 20000);
  assert.equal(again.unitPrice, line.unitPrice);
});

test('buildOdooLines: la línea de Artículo varios lleva la descripción como nombre', () => {
  const line = buildVariosLine(input, 'efectivo', []);
  const [odooLine] = buildOdooLines([line], 'efectivo', [56863], null);
  assert.equal(odooLine.name, '[ARTVARIOS] Lámpara sin etiqueta');
  assert.equal(odooLine.productId, 56863);
});
