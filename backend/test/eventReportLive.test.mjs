import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topProductOfDay, peakHourOfDay } from '../eventReport.mjs';

const sale = (date, total, items, status = 'completed') => ({ date, total, items, status });

test('topProductOfDay: most units that ART day, ignoring discounts and other days', () => {
  const docs = [
    sale('2026-10-30T15:00:00Z', 10, [{ name: 'A', qty: 1, unitPrice: 5 }, { name: 'Descuento', qty: 5, unitPrice: -1 }]),
    sale('2026-10-30T16:00:00Z', 10, [{ name: 'B', qty: 3, unitPrice: 5 }]),
    sale('2026-10-29T16:00:00Z', 10, [{ name: 'C', qty: 9, unitPrice: 5 }]),
    sale('2026-10-30T16:00:00Z', 10, [{ name: 'D', qty: 9, unitPrice: 5 }], 'cancelled'),
  ];
  assert.deepEqual(topProductOfDay(docs, '2026-10-30'), { name: 'B', units: 3 });
  assert.equal(topProductOfDay(docs, '2026-10-01'), null);
});

test('peakHourOfDay: ART hour with most completed revenue', () => {
  const docs = [
    sale('2026-10-30T00:30:00Z', 100, []), // 21h ART of the 29th
    sale('2026-10-30T15:10:00Z', 50, []),  // 12h
    sale('2026-10-30T15:50:00Z', 70, []),  // 12h
    sale('2026-10-30T18:00:00Z', 90, []),  // 15h
  ];
  assert.deepEqual(peakHourOfDay(docs, '2026-10-30'), { hour: 12, revenue: 120 });
  assert.deepEqual(peakHourOfDay(docs, '2026-10-29'), { hour: 21, revenue: 100 });
  assert.equal(peakHourOfDay(docs, '2026-10-01'), null);
});

import { buildLive } from '../eventReport.mjs';

const cell = (revenue, target) => ({ revenue, target, floor: target * 0.8, prevRevenue: 0, prevOrders: 0, orders: 0 });
const mkDay = (date, played, rev, target) => ({
  date, refDate: date.replace('2026', '2025'), played, inflationFactor: 1,
  web: cell(played ? rev : null, target), locales: cell(played ? rev : null, target),
});
const event = { current: { start: '2026-10-29', end: '2026-10-30' }, previous: { start: '2025-10-29', end: '2025-10-30' } };
const run = (today, days, nowIso) => buildLive({
  event, result: { days }, currentSales: [], prevSales: [], productsBySku: new Map(), today, ecommerceMeta: null, nowIso,
});

test('buildLive: before the event starts -> share 0, no projection', () => {
  const days = [mkDay('2026-10-29', false, 0, 100), mkDay('2026-10-30', false, 0, 100)];
  const live = run('2026-10-28', days, '2026-10-28T15:00:00Z');
  assert.deepEqual(live.todayShare, { web: 0, locales: 0 });
  assert.deepEqual(live.projection, { web: null, locales: null, total: null });
  assert.equal(live.todayStatus.total, null);
});

test('buildLive: during the event -> share from the curve and a projection', () => {
  const days = [mkDay('2026-10-29', true, 100, 100), mkDay('2026-10-30', true, 50, 100)];
  const live = run('2026-10-30', days, '2026-10-30T15:00:00Z'); // 12:00 ART, even curve
  assert.equal(live.todayShare.web, 0.5);
  assert.equal(live.todayStatus.web.pct, 100);
  assert.equal(live.projection.web, 200);
  assert.equal(live.projection.total, 400);
  assert.equal(live.updatedAt, null);
});

test('buildLive: after the event -> share 1, projection is the actual total', () => {
  const days = [mkDay('2026-10-29', true, 100, 100), mkDay('2026-10-30', true, 80, 100)];
  const live = run('2026-11-02', days, '2026-11-02T15:00:00Z');
  assert.deepEqual(live.todayShare, { web: 1, locales: 1 });
  assert.equal(live.projection.web, 180);
  assert.equal(live.todayStatus.web, null);
});

test('buildLive: projection.total is null when one group has no projection', () => {
  const days = [mkDay('2026-10-29', true, 100, 100), mkDay('2026-10-30', true, 50, 100)];
  days.forEach(d => { d.locales.target = 0; });
  const live = run('2026-10-30', days, '2026-10-30T15:00:00Z');
  assert.equal(live.projection.locales, null);
  assert.equal(live.projection.total, null);
});

test('buildLive: 2025 window day that is not a refDate uses the month-based inflation factor', () => {
  const ev = { current: { year: 2026, start: '2026-10-29', end: '2026-11-02' }, previous: { year: 2025, start: '2025-10-29', end: '2025-11-02' } };
  const productsBySku = new Map([['S1', { sku: 'S1', name: 'Silla', odooCategPath: 'All / Biblia/ MUEBLES / SILLAS / SILLA / X', stockByLocation: {} }]]);
  const prevSales = [{ id: 'p1', channel: 'ecommerce', date: '2025-11-01T15:00:00Z', status: 'completed', total: 100, items: [{ sku: 'S1', name: 'Silla', qty: 1, unitPrice: 100 }] }];
  const indexByMonth = new Map([['2025-11', 100], ['2026-11', 150]]);
  const live = buildLive({
    event: ev, result: { days: [mkDay('2026-10-29', true, 10, 100)] }, currentSales: [], prevSales, productsBySku,
    indexByMonth, today: '2026-10-29', ecommerceMeta: null, nowIso: '2026-10-29T15:00:00Z',
  });
  const sillas = live.categories.find(c => c.id === 'sillas');
  assert.ok(Math.abs(sillas.prevRevenueAdj - 150) < 1e-9);
});
