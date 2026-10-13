// test/posStats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePosStats, monthsBetween } from '../posStats.mjs';

const at = (iso) => ({ toMillis: () => new Date(iso).getTime() });
const order = (over) => ({
  status: 'confirmado', localId: 'LL', sellerId: 's1', sellerName: 'Ana', confirmedAt: at('2026-10-10T15:00:00-03:00'),
  payments: [{ methodId: 'efectivo', amount: null }], totals: { total: 12100, lineDiscountPct: 0 },
  lines: [{ sku: 'A', name: 'Silla', qty: 2, basePrice: 6050, status: 'activo' }], ...over,
});

test('computePosStats: totales, por local, vendedor, medio y productos', () => {
  const orders = [
    order({}),
    order({ localId: 'AL', sellerId: 's2', sellerName: 'Beto', totals: { total: 1210, lineDiscountPct: 0 }, lines: [{ sku: 'B', name: 'Mesa', qty: 1, basePrice: 1210, status: 'activo' }] }),
    order({ status: 'anulado' }),
    order({ confirmedAt: at('2026-09-01T10:00:00-03:00') }),
  ];
  const s = computePosStats(orders, { from: new Date('2026-10-01T00:00:00-03:00').getTime(), to: new Date('2026-11-01T00:00:00-03:00').getTime() });
  assert.equal(s.sales, 2);
  assert.equal(s.total, 13310);
  assert.equal(s.net, 11000);
  assert.equal(s.averageTicket, 6655);
  assert.deepEqual(s.byLocal, [{ localId: 'LL', sales: 1, total: 12100 }, { localId: 'AL', sales: 1, total: 1210 }]);
  assert.equal(s.bySeller[0].sellerName, 'Ana');
  assert.deepEqual(s.byMethod, { efectivo: 13310 });
  assert.deepEqual(s.topProducts[0], { sku: 'A', name: 'Silla', qty: 2, total: 12100 });
});

test('monthsBetween: meses que toca un rango', () => {
  assert.deepEqual(monthsBetween(new Date('2026-09-15T12:00:00-03:00'), new Date('2026-11-02T12:00:00-03:00')), ['2026-09', '2026-10', '2026-11']);
});
