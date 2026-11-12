import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSalesSummary } from '../webSales.mjs';

const doc = (total, { channel = 'ecommerce', status = 'completed', date = '2026-11-10T15:00:00Z', qty = 1 } = {}) => ({
  id: `${channel}-${Math.random()}`, channel, status, date, total, items: [{ sku: 'A', qty, unitPrice: total }],
});
const RANGE = { start: '2026-11-09', end: '2026-11-15' };

test('webSalesSummary: only completed ecommerce docs count', () => {
  const s = webSalesSummary({
    curDocs: [doc(100, { qty: 2 }), doc(50, { status: 'cancelled' }), doc(70, { channel: 'local_lomas' })],
    prevDocs: [], prevYearDocs: [], range: RANGE,
  });
  assert.equal(s.kpis.revenue.value, 100);
  assert.equal(s.kpis.orders.value, 1);
  assert.equal(s.kpis.units.value, 2);
  assert.equal(s.kpis.avgTicket.value, 100);
});

test('webSalesSummary: vsPrev and vsYear, money adjusted by inflation, counts never', () => {
  const base = { curDocs: [doc(100), doc(100)], prevDocs: [doc(100)], prevYearDocs: [doc(100)], range: RANGE };
  const adj = webSalesSummary({ ...base, inflation: { currentIndex: 200, prevYearIndex: 100 } });
  assert.equal(adj.kpis.revenue.vsPrev, 100);
  assert.equal(adj.kpis.revenue.vsYear, 0);
  assert.equal(adj.kpis.revenue.yearAdjusted, true);
  assert.equal(adj.kpis.orders.vsYear, 100);
  assert.equal(adj.kpis.orders.yearAdjusted, false);
  const nom = webSalesSummary(base);
  assert.equal(nom.kpis.revenue.vsYear, 100);
  assert.equal(nom.kpis.revenue.yearAdjusted, false);
});

test('webSalesSummary: empty previous periods give null deltas', () => {
  const s = webSalesSummary({ curDocs: [doc(100)], prevDocs: [], prevYearDocs: [], range: RANGE });
  assert.equal(s.kpis.revenue.vsPrev, null);
  assert.equal(s.kpis.revenue.vsYear, null);
});

test('webSalesSummary: daily uses the web group only', () => {
  const s = webSalesSummary({
    curDocs: [doc(100, { date: '2026-11-10T15:00:00Z' }), doc(30, { channel: 'mayorista', date: '2026-11-10T15:00:00Z' })],
    prevDocs: [], prevYearDocs: [doc(40, { date: '2025-11-10T15:00:00Z' })], range: RANGE, prevYearFactor: 2,
  });
  assert.equal(s.daily.bucket, 'day');
  assert.equal(s.daily.rows.length, 7);
  const day = s.daily.rows.find(r => r.key === '2026-11-10');
  assert.equal(day.total, 100);
  assert.equal(day.byChannel.web, 100);
  assert.equal(day.prevYearAdj, 80);
});
