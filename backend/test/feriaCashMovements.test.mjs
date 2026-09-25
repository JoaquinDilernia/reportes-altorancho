import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashSummary, buildCashMovement, voidCashMovement, cleanNotes } from '../feriaCash.mjs';

const now = new Date('2026-10-01T15:00:00Z');
const sale = (paymentMethod, unitPrice) => ({ status: 'confirmado', paymentMethod, shippingCost: 0, lines: [{ qty: 1, unitPrice, status: 'pendiente' }] });

test('buildCashMovement: gasto con concepto, retiro con concepto por defecto; monto en pesos', () => {
  assert.deepEqual(buildCashMovement({ type: 'gasto', concept: ' Comida ', amount: '3500' }, { user: 'Caja', now, id: 'm1' }), {
    id: 'm1', type: 'gasto', concept: 'Comida', amount: 3500, at: now, by: 'Caja',
  });
  assert.equal(buildCashMovement({ type: 'retiro', amount: 50000 }, { user: 'Caja', now, id: 'm2' }).concept, 'Retiro de dinero');
  assert.throws(() => buildCashMovement({ type: 'gasto', concept: ' ', amount: 1 }, { user: 'Caja', now, id: 'x' }), /concepto/);
  assert.throws(() => buildCashMovement({ type: 'prestamo', amount: 1 }, { user: 'Caja', now, id: 'x' }), /Tipo de salida inválido/);
  assert.throws(() => buildCashMovement({ type: 'retiro', amount: 0 }, { user: 'Caja', now, id: 'x' }), /Monto inválido/);
});

test('computeCashSummary: gastos y retiros salen del efectivo esperado; los anulados no cuentan', () => {
  const movements = [
    { id: 'm1', type: 'gasto', concept: 'Comida', amount: 3000 },
    { id: 'm2', type: 'gasto', concept: 'Librería', amount: 500 },
    { id: 'm3', type: 'retiro', concept: 'Retiro de dinero', amount: 20000 },
    { id: 'm4', type: 'gasto', concept: 'Error', amount: 999, voidedAt: now, voidedBy: 'Caja' },
  ];
  const s = computeCashSummary([sale('efectivo', 40000), sale('mp_debito', 10000)], { openingCash: 10000, movements });
  assert.equal(s.expenses, 3500);
  assert.equal(s.withdrawals, 20000);
  assert.equal(s.total, 50000, 'las salidas no cambian lo vendido');
  assert.equal(s.expectedCash, 10000 + 40000 - 3500 - 20000);
});

test('computeCashSummary: sin movimientos, como antes', () => {
  const s = computeCashSummary([sale('efectivo', 1000)], { openingCash: 0 });
  assert.equal(s.expenses, 0);
  assert.equal(s.withdrawals, 0);
  assert.equal(s.expectedCash, 1000);
});

test('voidCashMovement: marca anulado quién y cuándo; no se anula dos veces ni uno que no existe', () => {
  const movements = [{ id: 'm1', type: 'gasto', concept: 'Comida', amount: 3000 }];
  const next = voidCashMovement(movements, 'm1', { user: 'Caja', now });
  assert.deepEqual(next[0], { ...movements[0], voidedAt: now, voidedBy: 'Caja' });
  assert.throws(() => voidCashMovement(next, 'm1', { user: 'Caja', now }), /ya está anulad/);
  assert.throws(() => voidCashMovement(movements, 'mX', { user: 'Caja', now }), /no encontrad/);
});

test('cleanNotes: recorta espacios y limita el largo', () => {
  assert.equal(cleanNotes('  faltan 500 del cambio  '), 'faltan 500 del cambio');
  assert.equal(cleanNotes(undefined), '');
  assert.equal(cleanNotes('x'.repeat(3000)).length, 1000);
});
