import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, rangeBounds } from '../feriaStats.mjs';

// 23/09/2026 15:30 hora argentina = 18:30 UTC.
const at = (iso) => new Date(iso).getTime();
const line = (over) => ({ sku: 'A', modelo: 'Mesa', condition: 'falla', qty: 1, unitPrice: 850, listPrice: 1000, delivery: 'ahora', status: 'entregado', ...over });

const orders = [
  { status: 'confirmado', sellerName: 'Ana', paymentMethod: 'transferencia', shippingCost: 0, createdAtMs: at('2026-09-23T18:30:00Z'),
    lines: [line({ qty: 2 }), line({ sku: 'B', modelo: 'Taza', unitPrice: 85, listPrice: 100, status: 'eliminado' })] },
  { status: 'confirmado', sellerName: 'Beto', paymentMethod: 'efectivo', shippingCost: 10000, createdAtMs: at('2026-09-23T13:05:00Z'),
    lines: [line({ sku: 'B', modelo: 'Taza', unitPrice: 90, listPrice: 100, condition: 'discontinuo', delivery: 'envio' })] },
  { status: 'cancelado', sellerName: 'Ana', paymentMethod: 'efectivo', shippingCost: 0, createdAtMs: at('2026-09-23T14:00:00Z'), lines: [line()] },
  { status: 'pendiente', sellerName: 'Ana', paymentMethod: 'efectivo', shippingCost: 0, createdAtMs: at('2026-09-23T14:00:00Z'), lines: [line()] },
];

test('computeStats cuenta solo ventas confirmadas y líneas no eliminadas', () => {
  const s = computeStats(orders);
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.units, 3);
  assert.equal(s.totals.productsRevenue, 1700 + 90);
  assert.equal(s.totals.shippingRevenue, 10000);
  assert.equal(s.totals.revenue, 1790 + 10000);
  assert.equal(s.totals.discount, (2000 - 1700) + (100 - 90));
  assert.equal(s.totals.avgTicket, Math.round(11790 / 2));
});

test('computeStats agrupa por vendedor, medio de pago, condición y entrega', () => {
  const s = computeStats(orders);
  assert.deepEqual(s.bySeller, [
    { name: 'Beto', orders: 1, units: 1, revenue: 10090 },
    { name: 'Ana', orders: 1, units: 2, revenue: 1700 },
  ]);
  assert.deepEqual(s.byPayment.map((p) => [p.method, p.orders, p.revenue, p.discount]), [
    ['efectivo', 1, 10090, 10],
    ['transferencia', 1, 1700, 300],
  ]);
  assert.deepEqual(s.byCondition, { falla: { units: 2, revenue: 1700 }, discontinuo: { units: 1, revenue: 90 } });
  assert.deepEqual(s.byDelivery.envio, { units: 1, revenue: 90 });
});

test('computeStats arma el ranking de productos y las ventas por hora (hora argentina)', () => {
  const s = computeStats(orders);
  assert.deepEqual(s.topProducts[0], { sku: 'A', modelo: 'Mesa', units: 2, revenue: 1700 });
  assert.equal(s.byHour[15].orders, 1);
  assert.equal(s.byHour[10].orders, 1);
  assert.equal(s.byHour[10].revenue, 10090);
});

test('rangeBounds usa el día argentino (UTC-3)', () => {
  const now = at('2026-09-23T02:00:00Z'); // 22/09 23:00 en Argentina
  const { from, to } = rangeBounds('hoy', now);
  assert.equal(new Date(from).toISOString(), '2026-09-22T03:00:00.000Z');
  assert.equal(new Date(to).toISOString(), '2026-09-23T03:00:00.000Z');
  assert.equal(rangeBounds('todo', now).from, 0);
});

test('computeStats filtra por rango', () => {
  const s = computeStats(orders, { from: at('2026-09-23T15:00:00Z'), to: at('2026-09-23T20:00:00Z') });
  assert.equal(s.totals.orders, 1);
});
