import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_METHODS, tablePrice, computeFinalPrice } from '../feriaPricing.mjs';

const product = {
  precioFalla: 27990,
  precioDiscontinuo: 35990,
  precioRebaja1Falla: 21990,
  precioRebaja2Falla: 15990,
  precioRebaja1Discontinuo: 27990,
  precioRebaja2Discontinuo: 19990,
};

test('PAYMENT_METHODS tiene exactamente los 3 medios de pago con sus %', () => {
  assert.deepEqual(Object.keys(PAYMENT_METHODS).sort(), ['cuotas', 'efectivo', 'transferencia']);
  assert.equal(PAYMENT_METHODS.transferencia.discountPct, 20);
  assert.equal(PAYMENT_METHODS.efectivo.discountPct, 15);
  assert.equal(PAYMENT_METHODS.cuotas.discountPct, 0);
});

test('tablePrice devuelve el precio normal cuando la rebaja activa es 0', () => {
  assert.equal(tablePrice(product, 'falla', 0), 27990);
  assert.equal(tablePrice(product, 'discontinuo', 0), 35990);
});

test('tablePrice devuelve el precio de rebaja 1 o 2 según el nivel', () => {
  assert.equal(tablePrice(product, 'falla', 1), 21990);
  assert.equal(tablePrice(product, 'falla', 2), 15990);
  assert.equal(tablePrice(product, 'discontinuo', 1), 27990);
  assert.equal(tablePrice(product, 'discontinuo', 2), 19990);
});

test('tablePrice devuelve null si el SKU no tiene esa condición cargada', () => {
  assert.equal(tablePrice({ precioFalla: null }, 'falla', 0), null);
});

test('tablePrice rechaza una condición inválida', () => {
  assert.throws(() => tablePrice(product, 'nueva', 0), /Condición inválida/);
});

test('computeFinalPrice aplica el % de descuento del medio de pago sobre el precio de tabla', () => {
  assert.equal(computeFinalPrice(product, 'falla', 0, 'transferencia'), Math.round(27990 * 0.8));
  assert.equal(computeFinalPrice(product, 'falla', 0, 'efectivo'), Math.round(27990 * 0.85));
  assert.equal(computeFinalPrice(product, 'falla', 0, 'cuotas'), 27990);
});

test('computeFinalPrice combina rebaja activa y medio de pago', () => {
  assert.equal(computeFinalPrice(product, 'falla', 2, 'efectivo'), Math.round(15990 * 0.85));
});

test('computeFinalPrice devuelve null si la condición no tiene precio cargado', () => {
  assert.equal(computeFinalPrice({ precioFalla: null }, 'falla', 0, 'efectivo'), null);
});

test('computeFinalPrice rechaza un medio de pago inválido', () => {
  assert.throws(() => computeFinalPrice(product, 'falla', 0, 'cheque'), /Método de pago inválido/);
});
