// test/posCash.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashSummary, paymentsOf, buildPosCashMovement } from '../posCash.mjs';

const order = (payments, total, over = {}) => ({ status: 'confirmado', payments, totals: { total }, ...over });

test('paymentsOf: con un solo medio, todo el total va a ese medio', () => {
  assert.deepEqual(paymentsOf(order([{ methodId: 'efectivo', detailId: null, amount: null }], 8500)), [{ methodId: 'efectivo', detailId: null, amount: 8500 }]);
});

test('computeCashSummary: por medio y por detalle, pago dividido, anuladas aparte', () => {
  const orders = [
    order([{ methodId: 'efectivo', amount: null }], 8500),
    order([{ methodId: 'transferencia', amount: 3000 }, { methodId: 'credito', detailId: '6', amount: 7000 }], 10000),
    order([{ methodId: 'efectivo', amount: null }], 999, { status: 'anulado', odooOrderId: 1 }),
    order([{ methodId: 'efectivo', amount: null }], 5, { status: 'pendiente' }),
  ];
  const s = computeCashSummary(orders, { openingCash: 20000, movements: [] });
  assert.equal(s.sales, 2);
  assert.equal(s.annulled, 1);
  assert.deepEqual(s.byMethod, { efectivo: 8500, transferencia: 3000, credito: 7000 });
  assert.deepEqual(s.byDetail, { 'credito:6': 7000 });
  assert.equal(s.total, 18500);
  assert.equal(s.expectedCash, 28500);
});

test('computeCashSummary: gastos y retiros restan del efectivo; USD aparte; anulados no cuentan', () => {
  const movements = [
    { type: 'gasto', amount: 1500 }, { type: 'retiro', amount: 10000 },
    { type: 'gasto', amount: 999, voidedAt: new Date() },
    { type: 'ingreso_usd', usdAmount: 100, rate: 1200, amount: 120000 },
  ];
  const s = computeCashSummary([], { openingCash: 20000, countedCash: 8000, movements });
  assert.equal(s.expenses, 1500);
  assert.equal(s.withdrawals, 10000);
  assert.deepEqual(s.usd, { amount: 100, pesos: 120000 });
  assert.equal(s.expectedCash, 8500);
  assert.equal(s.difference, -500);
});

test('buildPosCashMovement: gasto pide concepto; USD pide monto y cotización', () => {
  const meta = { user: 'Caja', now: new Date(0), id: 'm1' };
  assert.throws(() => buildPosCashMovement({ type: 'gasto', amount: 100 }, meta), /concepto/);
  const usd = buildPosCashMovement({ type: 'ingreso_usd', usdAmount: 50, rate: 1100, concept: 'Pago LL-0003' }, meta);
  assert.equal(usd.amount, 55000);
  assert.throws(() => buildPosCashMovement({ type: 'ingreso_usd', usdAmount: 50 }, meta), /cotización/);
});

test('computeCashSummary: cambio cobra solo el neto; reintegro en efectivo resta; saldos aparte', () => {
  const orders = [
    order([{ methodId: 'efectivo', amount: null }], 30000, { kind: 'cambio', totals: { total: 30000, net: 8500, collect: 8500 } }),
    order([], 0, { kind: 'devolucion', totals: { total: 0, net: -5000, collect: 0 }, refund: { cashBack: [{ methodId: 'efectivo', amount: 2000 }, { methodId: 'transferencia', amount: 1000 }], credit: 2000 } }),
    order([{ methodId: 'saldo', amount: 3000 }, { methodId: 'credito', detailId: '6', amount: 7000 }], 10000),
  ];
  const s = computeCashSummary(orders, { openingCash: 10000, movements: [] });
  assert.deepEqual(s.byMethod, { efectivo: 8500, credito: 7000 });
  assert.deepEqual(s.refundsByMethod, { efectivo: 2000, transferencia: 1000 });
  assert.equal(s.refundsTotal, 3000);
  assert.equal(s.creditsIssued, 2000);
  assert.equal(s.creditsUsed, 3000);
  assert.equal(s.returns, 2);
  assert.equal(s.total, 15500);
  assert.equal(s.expectedCash, 16500); // 10.000 + 8.500 − 2.000
});

test('paymentsOf: devolución sin pagos no suma nada', () => {
  assert.deepEqual(paymentsOf({ payments: [], totals: { total: 0, collect: 0 } }), []);
});
