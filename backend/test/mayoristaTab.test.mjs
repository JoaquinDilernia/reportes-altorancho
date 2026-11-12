import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayoristaSummary, feriaTeams } from '../mayoristaTab.mjs';

let seq = 0;
const doc = (total, { channel = 'mayorista', status = 'completed', amountCollected = 0, team, qty = 1 } = {}) => ({
  id: `${channel}-${seq++}`, channel, status, date: '2026-11-03T15:00:00Z', total, amountCollected,
  ...(team ? { team } : {}), items: [{ sku: 'A', qty, unitPrice: total / qty }],
});

test('mayoristaSummary: feria counts inside the totals', () => {
  const s = mayoristaSummary({ curDocs: [doc(1000), doc(500, { channel: 'feria' }), doc(90, { channel: 'ecommerce' })], prevDocs: [], yearDocs: [] });
  assert.equal(s.kpis.revenue.value, 1500);
  assert.equal(s.kpis.orders.value, 2);
  assert.equal(s.kpis.avgTicket.value, 750);
  assert.deepEqual(s.sources.map(x => [x.id, x.revenue, x.orders, x.sharePct]), [['mayorista', 1000, 1, 66.7], ['feria', 500, 1, 33.3]]);
});

test('mayoristaSummary: collected only over mayorista docs', () => {
  const s = mayoristaSummary({ curDocs: [doc(1000, { amountCollected: 400 }), doc(500, { channel: 'feria' })], prevDocs: [], yearDocs: [] });
  assert.deepEqual(s.collected, { invoiced: 1000, collected: 400, rate: 40 });
});

test('mayoristaSummary: no sales → null ticket and rate', () => {
  const s = mayoristaSummary({ curDocs: [], prevDocs: [doc(100)], yearDocs: [] });
  assert.equal(s.kpis.revenue.value, 0);
  assert.equal(s.kpis.avgTicket.value, null);
  assert.equal(s.kpis.avgTicket.vsPrev, null);
  assert.equal(s.kpis.revenue.vsPrev, -100);
  assert.deepEqual(s.collected, { invoiced: 0, collected: 0, rate: null });
  assert.deepEqual(s.sources.map(x => x.sharePct), [0, 0]);
});

test('mayoristaSummary: vs year adjusts money only', () => {
  const s = mayoristaSummary({ curDocs: [doc(200)], prevDocs: [], yearDocs: [doc(100)], inflation: { currentIndex: 200, prevYearIndex: 100 } });
  assert.equal(s.kpis.revenue.vsYear, 0);
  assert.equal(s.kpis.revenue.yearAdjusted, true);
  assert.equal(s.kpis.orders.vsYear, 0);
  assert.equal(s.kpis.orders.yearAdjusted, false);
});

test('feriaTeams: docs without team go to Sin equipo', () => {
  const t = feriaTeams([
    doc(300, { channel: 'feria', team: 'Presentes' }), doc(100, { channel: 'feria', team: 'Presentes' }),
    doc(100, { channel: 'feria' }), doc(999), doc(50, { channel: 'feria', team: 'Hotelga', status: 'cancelled' }),
  ]);
  assert.deepEqual(t, [
    { team: 'Presentes', revenue: 400, orders: 2, sharePct: 80 },
    { team: 'Sin equipo', revenue: 100, orders: 1, sharePct: 20 },
  ]);
});
