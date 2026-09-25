import { test } from 'node:test';
import assert from 'node:assert/strict';
import { principalPaymentMethod } from '../feriaPricing.mjs';
import { orderTotal, paymentsOf, validatePayments, assertPaymentsMatchTotal } from '../feriaLines.mjs';
import { computeCashSummary } from '../feriaCash.mjs';
import { computeStats } from '../feriaStats.mjs';

const line = (over) => ({ qty: 1, listPrice: 100000, unitPrice: 100000, status: 'pendiente', ...over });

test('principalPaymentMethod: a Odoo va el de mayor costo (MP 3 > MP 1 > débito > transferencia > efectivo)', () => {
  assert.equal(principalPaymentMethod(['efectivo', 'mp_debito']), 'mp_debito');
  assert.equal(principalPaymentMethod(['efectivo', 'transferencia']), 'transferencia');
  assert.equal(principalPaymentMethod(['mp_1_cuota', 'mp_3_cuotas', 'efectivo']), 'mp_3_cuotas');
  assert.equal(principalPaymentMethod(['efectivo']), 'efectivo');
});

test('orderTotal: productos no eliminados + envío', () => {
  assert.equal(orderTotal({ shippingCost: 25000, lines: [line(), line({ status: 'eliminado' })] }), 125000);
});

test('paymentsOf: un solo medio → todo el total en ese medio; dividido → los montos cargados', () => {
  assert.deepEqual(paymentsOf({ paymentMethod: 'efectivo', lines: [line()] }), [{ method: 'efectivo', amount: 100000 }]);
  const split = [{ method: 'efectivo', amount: 40000 }, { method: 'mp_debito', amount: 60000 }];
  assert.deepEqual(paymentsOf({ paymentMethod: 'mp_debito', payments: split, lines: [line()] }), split);
});

test('validatePayments: medios válidos, sin repetir, montos mayores a 0', () => {
  assert.deepEqual(validatePayments([{ method: 'efectivo', amount: '40000' }, { method: 'mp_debito', amount: 60000.004 }]),
    [{ method: 'efectivo', amount: 40000 }, { method: 'mp_debito', amount: 60000 }]);
  assert.throws(() => validatePayments([]), /al menos un medio/);
  assert.throws(() => validatePayments([{ method: 'cheque', amount: 1 }]), /Medio de pago inválido/);
  assert.throws(() => validatePayments([{ method: 'efectivo', amount: 1 }, { method: 'efectivo', amount: 2 }]), /repetido/);
  assert.throws(() => validatePayments([{ method: 'efectivo', amount: 0 }, { method: 'mp_debito', amount: 5 }]), /Monto inválido/);
  assert.deepEqual(validatePayments([{ method: 'efectivo' }]), [{ method: 'efectivo' }], 'un solo medio: sin monto');
});

test('assertPaymentsMatchTotal: el pago dividido tiene que sumar exacto el total', () => {
  const order = { paymentMethod: 'mp_debito', lines: [line()], payments: [{ method: 'efectivo', amount: 40000 }, { method: 'mp_debito', amount: 60000 }] };
  assert.doesNotThrow(() => assertPaymentsMatchTotal(order));
  assert.doesNotThrow(() => assertPaymentsMatchTotal({ paymentMethod: 'efectivo', lines: [line()] }));
  assert.throws(() => assertPaymentsMatchTotal({ ...order, lines: [line({ unitPrice: 90000 })] }), /suman \$ 100\.000.*total es \$ 90\.000/);
});

test('computeCashSummary: cada parte del pago dividido suma a su medio (el efectivo esperado solo cuenta lo pagado en efectivo)', () => {
  const orders = [{
    status: 'confirmado', paymentMethod: 'mp_debito', shippingCost: 0, lines: [line()],
    payments: [{ method: 'efectivo', amount: 40000 }, { method: 'mp_debito', amount: 60000 }],
  }];
  const s = computeCashSummary(orders, { openingCash: 10000 });
  assert.equal(s.byMethod.efectivo, 40000);
  assert.equal(s.byMethod.mercadopago.mp_debito, 60000);
  assert.equal(s.total, 100000);
  assert.equal(s.expectedCash, 50000);
});

test('computeStats: por medio de pago reparte la facturación según el pago dividido', () => {
  const orders = [{
    status: 'confirmado', createdAtMs: Date.parse('2026-10-01T15:00:00Z'), paymentMethod: 'mp_debito', shippingCost: 0,
    lines: [line({ sku: 'A', modelo: 'Mesa', condition: 'falla', delivery: 'ahora', status: 'entregado' })],
    payments: [{ method: 'efectivo', amount: 40000 }, { method: 'mp_debito', amount: 60000 }],
  }];
  const byMethod = Object.fromEntries(computeStats(orders).byPayment.map((p) => [p.method, p.revenue]));
  assert.deepEqual(byMethod, { efectivo: 40000, mp_debito: 60000 });
});
