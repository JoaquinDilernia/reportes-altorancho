import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTotals,
  computeTopProducts,
  computeCategoryBreakdown,
  computePaymentMethods,
  computeProvinces,
  computeDelta,
  computeDailyBreakdown,
  computeDailyBreakdownByChannel,
} from '../aggregate.mjs';

function makeSale(overrides) {
  return {
    id: 'x', channel: 'ecommerce', sourceId: '1', date: '2026-07-01T00:00:00Z',
    status: 'completed', total: 1000, paymentMethod: 'Mercado Pago', shippingProvince: 'Capital Federal',
    items: [{ sku: 'A', name: 'Producto A', category: 'Sillas', qty: 1, unitPrice: 1000 }],
    ...overrides,
  };
}

test('computeTotals sums revenue, units and orders, ignoring non-completed', () => {
  const sales = [
    makeSale({ total: 1000, items: [{ sku: 'A', name: 'A', category: 'Sillas', qty: 2, unitPrice: 500 }] }),
    makeSale({ total: 2000, date: '2026-07-02T00:00:00Z', items: [{ sku: 'B', name: 'B', category: 'Mesas', qty: 1, unitPrice: 2000 }] }),
    makeSale({ status: 'cancelled', total: 9999 }),
  ];

  const totals = computeTotals(sales);

  assert.equal(totals.revenue, 3000);
  assert.equal(totals.units, 3);
  assert.equal(totals.orders, 2);
  assert.equal(totals.avgTicket, 1500);
  assert.equal(totals.daysInRange, 2); // 2026-07-01 and 2026-07-02
  assert.equal(totals.avgDailyRevenue, 1500);
});

test('computeTotals handles an empty period without dividing by zero', () => {
  const totals = computeTotals([]);
  assert.equal(totals.revenue, 0);
  assert.equal(totals.orders, 0);
  assert.equal(totals.avgTicket, 0);
  assert.equal(totals.avgDailyRevenue, 0);
  assert.equal(totals.cancelledOrders, 0);
  assert.equal(totals.cancellationRate, 0);
});

test('computeTotals sums shippingRevenue over completed sales, defaulting missing values to 0', () => {
  const sales = [
    makeSale({ shippingRevenue: 500 }),
    makeSale({ shippingRevenue: 300 }),
    makeSale({ status: 'cancelled', shippingRevenue: 9999 }),
    makeSale({}), // Locales/Mayorista-style doc with no shippingRevenue field at all
  ];

  const totals = computeTotals(sales);

  assert.equal(totals.shippingRevenue, 800);
});

test('computeTotals sums amountCollected and derives collectionRate, defaulting missing values to 0', () => {
  const sales = [
    makeSale({ total: 1000, amountCollected: 1000 }),
    makeSale({ total: 1000, amountCollected: 0 }),
    makeSale({ status: 'cancelled', total: 9999, amountCollected: 9999 }),
    makeSale({ total: 1000 }), // ecommerce/locales-style doc with no amountCollected field at all
  ];
  const totals = computeTotals(sales);
  assert.equal(totals.amountCollected, 1000);
  assert.equal(totals.collectionRate, Math.round((1000 / 3000) * 10000) / 100);
});

test('computeTotals computes cancellationRate over completed+cancelled, ignoring pending', () => {
  const sales = [
    makeSale({ status: 'completed' }),
    makeSale({ status: 'completed' }),
    makeSale({ status: 'completed' }),
    makeSale({ status: 'cancelled' }),
    makeSale({ status: 'pending' }),
  ];
  const totals = computeTotals(sales);
  assert.equal(totals.cancelledOrders, 1);
  assert.equal(totals.cancellationRate, 25); // 1 of 4 finalized (3 completed + 1 cancelled)
});

test('computeTopProducts ranks by units sold', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 5, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Mesa', category: 'Mesas', qty: 2, unitPrice: 500 }] }),
  ];
  const productsBySku = new Map([
    ['A', { currentStock: 10 }],
    ['B', { currentStock: 0 }],
  ]);

  const top = computeTopProducts(sales, productsBySku, { by: 'units', limit: 2 });

  assert.equal(top[0].sku, 'A');
  assert.equal(top[0].unitsSold, 5);
  assert.equal(top[0].revenue, 500);
  assert.equal(top[0].currentStock, 10);
  assert.equal(top[1].sku, 'B');
});

test('computeTopProducts carries stockByLocation through from the product catalog', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 1, unitPrice: 100 }] })];
  const productsBySku = new Map([
    ['A', { currentStock: 0, stockByLocation: { local_lomas: 20, ecommerce_odoo: 0 } }],
  ]);

  const top = computeTopProducts(sales, productsBySku, { by: 'units', limit: 1 });

  assert.deepEqual(top[0].stockByLocation, { local_lomas: 20, ecommerce_odoo: 0 });
});

test('computeTopProducts sets stockByLocation to null when the catalog has no per-location data', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 1, unitPrice: 100 }] })];
  const top = computeTopProducts(sales, new Map(), { by: 'units', limit: 1 });
  assert.equal(top[0].stockByLocation, null);
});

test('computeTopProducts carries nombreModeloAr and odooTemplateId through from the product catalog', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 1, unitPrice: 100 }] })];
  const productsBySku = new Map([
    ['A', { currentStock: 0, nombreModeloAr: 'CARDONA', odooTemplateId: 40990 }],
  ]);

  const top = computeTopProducts(sales, productsBySku, { by: 'units', limit: 1 });

  assert.equal(top[0].nombreModeloAr, 'CARDONA');
  assert.equal(top[0].odooTemplateId, 40990);
});

test('computeTopProducts sets nombreModeloAr and odooTemplateId to null when the catalog has no match', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 1, unitPrice: 100 }] })];
  const top = computeTopProducts(sales, new Map(), { by: 'units', limit: 1 });
  assert.equal(top[0].nombreModeloAr, null);
  assert.equal(top[0].odooTemplateId, null);
});

test('computeTopProducts ranks by revenue', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 5, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Mesa', category: 'Mesas', qty: 2, unitPrice: 500 }] }),
  ];
  const top = computeTopProducts(sales, new Map(), { by: 'revenue', limit: 1 });
  assert.equal(top.length, 1);
  assert.equal(top[0].sku, 'B');
  assert.equal(top[0].revenue, 1000);
});

test('computeCategoryBreakdown groups units by category', () => {
  const sales = [
    makeSale({ items: [{ sku: 'A', name: 'Silla', category: 'Sillas', qty: 3, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'B', name: 'Silla 2', category: 'Sillas', qty: 2, unitPrice: 100 }] }),
    makeSale({ items: [{ sku: 'C', name: 'Mesa', category: 'Mesas', qty: 1, unitPrice: 500 }] }),
  ];
  const breakdown = computeCategoryBreakdown(sales);
  assert.deepEqual(breakdown.find(c => c.category === 'Sillas'), { category: 'Sillas', units: 5, revenue: 500 });
  assert.deepEqual(breakdown.find(c => c.category === 'Mesas'), { category: 'Mesas', units: 1, revenue: 500 });
});

test('computeCategoryBreakdown groups missing category as "Sin categoría"', () => {
  const sales = [makeSale({ items: [{ sku: 'A', name: 'A', category: null, qty: 1, unitPrice: 100 }] })];
  const breakdown = computeCategoryBreakdown(sales);
  assert.equal(breakdown[0].category, 'Sin categoría');
});

test('computeCategoryBreakdown recovers the category string from legacy docs where category was stored as a product object', () => {
  const sales = [makeSale({
    items: [{
      sku: 'A',
      name: 'A',
      category: { sku: 'A', name: 'A', category: 'Muebles', currentStock: 2 },
      qty: 1,
      unitPrice: 100,
    }],
  })];
  const breakdown = computeCategoryBreakdown(sales);
  assert.equal(breakdown[0].category, 'Muebles');
});

test('computePaymentMethods groups revenue by payment method', () => {
  const sales = [
    makeSale({ paymentMethod: 'Mercado Pago', total: 1000 }),
    makeSale({ paymentMethod: 'Mercado Pago', total: 500 }),
    makeSale({ paymentMethod: 'Pago Nube', total: 300 }),
  ];
  const methods = computePaymentMethods(sales);
  assert.deepEqual(methods.find(m => m.method === 'Mercado Pago'), { method: 'Mercado Pago', revenue: 1500 });
  assert.deepEqual(methods.find(m => m.method === 'Pago Nube'), { method: 'Pago Nube', revenue: 300 });
});

test('computeProvinces groups orders by shipping province, ignoring nulls', () => {
  const sales = [
    makeSale({ shippingProvince: 'Capital Federal' }),
    makeSale({ shippingProvince: 'Capital Federal' }),
    makeSale({ shippingProvince: 'Córdoba' }),
    makeSale({ shippingProvince: null }),
  ];
  const provinces = computeProvinces(sales);
  assert.deepEqual(provinces.find(p => p.province === 'Capital Federal'), { province: 'Capital Federal', orders: 2 });
  assert.equal(provinces.find(p => p.province === 'Córdoba').orders, 1);
  assert.equal(provinces.length, 2);
});

test('computeDelta returns absolute and percent change', () => {
  assert.deepEqual(computeDelta(150, 100), { value: 50, pct: 50 });
});

test('computeDelta handles a zero baseline without dividing by zero', () => {
  assert.deepEqual(computeDelta(150, 0), { value: 150, pct: null });
});

test('computeDailyBreakdown groups revenue/units/orders by Argentina calendar day, sorted ascending', () => {
  const sales = [
    makeSale({ date: '2026-07-02T15:00:00Z', total: 1000, items: [{ sku: 'A', name: 'A', category: 'Sillas', qty: 2, unitPrice: 500 }] }),
    makeSale({ date: '2026-07-01T15:00:00Z', total: 500, items: [{ sku: 'B', name: 'B', category: 'Mesas', qty: 1, unitPrice: 500 }] }),
    makeSale({ date: '2026-07-01T18:00:00Z', total: 300, items: [{ sku: 'C', name: 'C', category: 'Mesas', qty: 1, unitPrice: 300 }] }),
  ];

  const daily = computeDailyBreakdown(sales);

  assert.deepEqual(daily, [
    { date: '2026-07-01', revenue: 800, units: 2, orders: 2 },
    { date: '2026-07-02', revenue: 1000, units: 2, orders: 1 },
  ]);
});

test('computeDailyBreakdown excludes non-completed orders', () => {
  const sales = [
    makeSale({ date: '2026-07-01T15:00:00Z', total: 1000 }),
    makeSale({ date: '2026-07-01T15:00:00Z', total: 9999, status: 'cancelled' }),
  ];
  const daily = computeDailyBreakdown(sales);
  assert.deepEqual(daily, [{ date: '2026-07-01', revenue: 1000, units: 1, orders: 1 }]);
});

test('computeDailyBreakdown buckets a UTC-midnight sale into the previous Argentina calendar day', () => {
  const sales = [makeSale({ date: '2026-07-01T00:00:00Z', total: 1000 })];
  const daily = computeDailyBreakdown(sales);
  assert.deepEqual(daily, [{ date: '2026-06-30', revenue: 1000, units: 1, orders: 1 }]);
});

test('computeDailyBreakdownByChannel groups revenue by day and channel, zero-filling absent channels', () => {
  const sales = [
    makeSale({ date: '2026-07-01T15:00:00Z', total: 1000, channel: 'ecommerce' }),
    makeSale({ date: '2026-07-01T15:00:00Z', total: 500, channel: 'local_lomas' }),
    makeSale({ date: '2026-07-02T15:00:00Z', total: 300, channel: 'ecommerce' }),
  ];

  const daily = computeDailyBreakdownByChannel(sales, ['ecommerce', 'local_lomas']);

  assert.deepEqual(daily, [
    { date: '2026-07-01', ecommerce: 1000, local_lomas: 500 },
    { date: '2026-07-02', ecommerce: 300, local_lomas: 0 },
  ]);
});

test('computeDailyBreakdownByChannel excludes non-completed orders', () => {
  const sales = [
    makeSale({ date: '2026-07-01T15:00:00Z', total: 1000, channel: 'ecommerce' }),
    makeSale({ date: '2026-07-01T15:00:00Z', total: 9999, channel: 'ecommerce', status: 'cancelled' }),
  ];
  const daily = computeDailyBreakdownByChannel(sales, ['ecommerce']);
  assert.deepEqual(daily, [{ date: '2026-07-01', ecommerce: 1000 }]);
});
