import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_METHODS, tablePrice, computeFinalPrice, odooLinePricing, netOfIva, IVA_RATE, SHIPPING_COST } from '../feriaPricing.mjs';

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

test('tablePrice rechaza un nivel de rebaja inválido', () => {
  assert.throws(() => tablePrice(product, 'falla', 3), /Nivel de rebaja inválido/);
  assert.throws(() => tablePrice(product, 'falla', -1), /Nivel de rebaja inválido/);
  assert.throws(() => tablePrice(product, 'falla', undefined), /Nivel de rebaja inválido/);
  assert.throws(() => tablePrice(product, 'falla', '1'), /Nivel de rebaja inválido/);
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

test('cada medio de pago tiene su nombre de payment.method en Odoo', () => {
  assert.equal(PAYMENT_METHODS.transferencia.odooName, 'Transferencia');
  assert.equal(PAYMENT_METHODS.efectivo.odooName, 'Efectivo');
  assert.equal(PAYMENT_METHODS.cuotas.odooName, 'Mercado Pago 3 cuotas');
});

test('netOfIva saca el 21% y redondea a centavos', () => {
  assert.equal(IVA_RATE, 0.21);
  assert.equal(netOfIva(9990), 8256.2);
  assert.equal(netOfIva(10000), 8264.46);
});

test('SHIPPING_COST es 10000', () => {
  assert.equal(SHIPPING_COST, 10000);
});

test('odooLinePricing manda el precio de tabla SIN IVA y el descuento del medio de pago aparte', () => {
  assert.deepEqual(
    odooLinePricing({ listPrice: 9990, unitPrice: 7992 }, 'transferencia'),
    { unitPrice: 8256.2, discountPct: 20 },
  );
  assert.deepEqual(
    odooLinePricing({ listPrice: 9990, unitPrice: 9990 }, 'cuotas'),
    { unitPrice: 8256.2, discountPct: 0 },
  );
});

test('odooLinePricing reconstruye el precio de tabla en pedidos viejos sin listPrice', () => {
  assert.deepEqual(
    odooLinePricing({ unitPrice: 7992 }, 'transferencia'),
    { unitPrice: 8256.2, discountPct: 20 },
  );
});

test('con el precio sin IVA, el total que calcula Odoo vuelve a dar el precio que paga el cliente', () => {
  const { unitPrice, discountPct } = odooLinePricing({ listPrice: 9990, unitPrice: 7992 }, 'transferencia');
  const subtotal = Math.round(unitPrice * (1 - discountPct / 100) * 100) / 100;
  assert.equal(Math.round(subtotal * (1 + IVA_RATE) * 100) / 100, 7992);
});

test('odooLinePricing rechaza un medio de pago inválido', () => {
  assert.throws(() => odooLinePricing({ listPrice: 100, unitPrice: 100 }, 'cheque'), /Método de pago inválido/);
});
