import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashSummary, parseAmount, assertCanConfirmWithCash } from '../feriaCash.mjs';

const line = (over) => ({ qty: 1, unitPrice: 1000, status: 'pendiente', ...over });
const order = (paymentMethod, over = {}) => ({ status: 'confirmado', paymentMethod, shippingCost: 0, lines: [line()], ...over });

test('computeCashSummary: separa efectivo, transferencia y Mercado Pago (con su detalle) y suma el total', () => {
  const orders = [
    order('efectivo', { lines: [line({ qty: 2, unitPrice: 900 })] }),                     // 1800
    order('efectivo', { shippingCost: 10000 }),                                             // 1000 + 10000 de envío
    order('transferencia', { lines: [line({ unitPrice: 850 }), line({ unitPrice: 5, status: 'eliminado' })] }), // 850
    order('mp_debito'),                                                                     // 1000
    order('mp_3_cuotas', { lines: [line({ unitPrice: 3000 })] }),                           // 3000
  ];
  const s = computeCashSummary(orders, { openingCash: 20000 });
  assert.equal(s.sales, 5);
  assert.equal(s.byMethod.efectivo, 12800);
  assert.equal(s.byMethod.transferencia, 850);
  assert.deepEqual(s.byMethod.mercadopago, { total: 4000, mp_debito: 1000, mp_1_cuota: 0, mp_3_cuotas: 3000 });
  assert.equal(s.total, 17650);
  assert.equal(s.openingCash, 20000);
  assert.equal(s.expectedCash, 32800);
  assert.equal(s.countedCash, null);
  assert.equal(s.difference, null);
});

test('computeCashSummary: con el efectivo contado calcula la diferencia (negativa si falta)', () => {
  const s = computeCashSummary([order('efectivo')], { openingCash: 5000, countedCash: 5900 });
  assert.equal(s.expectedCash, 6000);
  assert.equal(s.difference, -100);
});

test('computeCashSummary: las ventas anuladas o sin confirmar no suman (las anuladas se cuentan aparte)', () => {
  const orders = [
    order('efectivo'),
    order('efectivo', { status: 'cancelado', odooOrderId: 9 }),
    order('efectivo', { status: 'pendiente' }),
  ];
  const s = computeCashSummary(orders, { openingCash: 0 });
  assert.equal(s.sales, 1);
  assert.equal(s.total, 1000);
  assert.equal(s.annulled, 1);
});

test('parseAmount: montos en pesos, no negativos, redondeados a centavos', () => {
  assert.equal(parseAmount(20000), 20000);
  assert.equal(parseAmount('15000.456'), 15000.46);
  assert.equal(parseAmount(0), 0);
  assert.throws(() => parseAmount(-1), /Monto inválido/);
  assert.throws(() => parseAmount('abc'), /Monto inválido/);
  assert.throws(() => parseAmount(null), /Monto inválido/);
  assert.throws(() => parseAmount(''), /Monto inválido/);
});

test('assertCanConfirmWithCash: sin caja abierta no se confirman ventas', () => {
  assert.throws(() => assertCanConfirmWithCash(null), /caja está cerrada/);
  assert.throws(() => assertCanConfirmWithCash({}), /caja está cerrada/);
  assert.equal(assertCanConfirmWithCash({ openSessionId: 'abc' }), 'abc');
});
