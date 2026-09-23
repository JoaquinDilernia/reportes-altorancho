import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_METHODS, PUBLIC_PRICE_OPTIONS, rebajaLevels, withRebaja, unitCostOf, tablePrice, computeFinalPrice, odooLinePricing, netOfIva, IVA_RATE, SHIPPING_COST } from '../feriaPricing.mjs';

const product = {
  precioFalla: 27990,
  precioDiscontinuo: 35990,
  precioRebaja1Falla: 21990,
  precioRebaja2Falla: 15990,
  precioRebaja1Discontinuo: 27990,
  precioRebaja2Discontinuo: 19990,
};

test('PAYMENT_METHODS tiene los 5 medios de pago con sus %', () => {
  assert.deepEqual(Object.keys(PAYMENT_METHODS), ['transferencia', 'efectivo', 'mp_debito', 'mp_1_cuota', 'mp_3_cuotas']);
  assert.equal(PAYMENT_METHODS.transferencia.discountPct, 15);
  assert.equal(PAYMENT_METHODS.efectivo.discountPct, 10);
  assert.equal(PAYMENT_METHODS.mp_debito.discountPct, 0);
  assert.equal(PAYMENT_METHODS.mp_1_cuota.discountPct, 0);
  assert.equal(PAYMENT_METHODS.mp_3_cuotas.discountPct, 0);
});

test('PUBLIC_PRICE_OPTIONS agrupa Mercado Pago en un solo precio para el buscador público', () => {
  assert.deepEqual(PUBLIC_PRICE_OPTIONS.map((o) => [o.key, o.method]), [
    ['transferencia', 'transferencia'], ['efectivo', 'efectivo'], ['mercadopago', 'mp_debito'],
  ]);
  assert.equal(PUBLIC_PRICE_OPTIONS[2].label, 'Mercado Pago (débito o cuotas)');
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
  assert.equal(computeFinalPrice(product, 'falla', 0, 'transferencia'), Math.round(27990 * 0.85));
  assert.equal(computeFinalPrice(product, 'falla', 0, 'efectivo'), Math.round(27990 * 0.9));
  assert.equal(computeFinalPrice(product, 'falla', 0, 'mp_3_cuotas'), 27990);
});

test('computeFinalPrice combina rebaja activa y medio de pago', () => {
  assert.equal(computeFinalPrice(product, 'falla', 2, 'efectivo'), Math.round(15990 * 0.9));
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
  assert.equal(PAYMENT_METHODS.mp_debito.odooName, 'Mercado Pago Debito');
  assert.equal(PAYMENT_METHODS.mp_1_cuota.odooName, 'Mercado Pago 1 cuota');
  assert.equal(PAYMENT_METHODS.mp_3_cuotas.odooName, 'Mercado Pago 3 cuotas');
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
    odooLinePricing({ listPrice: 9990, unitPrice: 8492 }, 'transferencia'),
    { unitPrice: 8256.2, discountPct: 15 },
  );
  assert.deepEqual(
    odooLinePricing({ listPrice: 9990, unitPrice: 9990 }, 'mp_3_cuotas'),
    { unitPrice: 8256.2, discountPct: 0 },
  );
});

test('odooLinePricing reconstruye el precio de tabla en pedidos viejos sin listPrice', () => {
  assert.deepEqual(
    odooLinePricing({ unitPrice: 8500 }, 'transferencia'),
    { unitPrice: 8264.46, discountPct: 15 },
  );
});

test('con el precio sin IVA, el total que calcula Odoo vuelve a dar el precio que paga el cliente', () => {
  const { unitPrice, discountPct } = odooLinePricing({ listPrice: 9990, unitPrice: 8492 }, 'transferencia');
  const subtotal = Math.round(unitPrice * (1 - discountPct / 100) * 100) / 100;
  assert.equal(Math.round(subtotal * (1 + IVA_RATE) * 100) / 100, 8491.5);
});

test('odooLinePricing rechaza un medio de pago inválido', () => {
  assert.throws(() => odooLinePricing({ listPrice: 100, unitPrice: 100 }, 'cheque'), /Método de pago inválido/);
});

test('rebajaLevels: los 3 niveles de una condición con su precio por medio de pago (MMA010BL)', () => {
  const mma = {
    precioFalla: 73990, precioRebaja1Falla: 58990, precioRebaja2Falla: 43990,
    precioDiscontinuo: 95990, precioRebaja1Discontinuo: 75990, precioRebaja2Discontinuo: 56990,
  };
  assert.deepEqual(rebajaLevels(mma, 'falla'), [
    { level: 0, precioTabla: 73990, precios: { transferencia: 62892, efectivo: 66591, mercadopago: 73990 } },
    { level: 1, precioTabla: 58990, precios: { transferencia: 50142, efectivo: 53091, mercadopago: 58990 } },
    { level: 2, precioTabla: 43990, precios: { transferencia: 37392, efectivo: 39591, mercadopago: 43990 } },
  ]);
  assert.deepEqual(rebajaLevels(mma, 'discontinuo').map((l) => l.precios.transferencia), [81592, 64592, 48442]);
});

test('rebajaLevels: un nivel sin precio cargado en el Excel no se ofrece', () => {
  const partial = { precioFalla: 1000, precioRebaja1Falla: null };
  assert.deepEqual(rebajaLevels(partial, 'falla').map((l) => l.level), [0]);
  assert.deepEqual(rebajaLevels({}, 'falla'), []);
});

test('withRebaja: el producto con la rebaja nueva ya aplicada (la respuesta al activar muestra el precio nuevo)', () => {
  const p = { ...product, rebajaFallaActiva: 1, rebajaDiscontinuoActiva: 0 };
  const updated = withRebaja(p, 'falla', 2);
  assert.equal(updated.rebajaFallaActiva, 2);
  assert.equal(tablePrice(updated, 'falla', updated.rebajaFallaActiva), 15990);
  assert.equal(p.rebajaFallaActiva, 1, 'no modifica el original');
  assert.equal(withRebaja(p, 'discontinuo', 1).rebajaDiscontinuoActiva, 1);
  assert.throws(() => withRebaja(p, 'falla', 3), /Nivel de rebaja inválido/);
  assert.throws(() => withRebaja(p, 'nueva', 1), /Condición inválida/);
});

test('unitCostOf: costo galpón (sin IVA) redondeado a centavos; null si el Excel no lo trae', () => {
  assert.equal(unitCostOf({ costoGalpon: 52110.601314329 }), 52110.6);
  assert.equal(unitCostOf({ costoGalpon: null }), null);
  assert.equal(unitCostOf({}), null);
  assert.equal(unitCostOf(null), null);
});
