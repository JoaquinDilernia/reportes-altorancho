import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTS, alignEventDays, projectInflationIndex, inflationFactor, dailyByChannel,
  weekdayBaseline, buildEventDays, summarizePastEvent, weekdayOf, baselineRange,
} from '../events.mjs';

test('alignEventDays: Cyber Monday lines up with Cyber Monday, same weekday', () => {
  const days = alignEventDays(EVENTS.cyber.current, EVENTS.cyber.previous);
  const monday = days.find(d => d.date === '2026-11-02');
  assert.equal(monday.refDate, '2025-11-03');
  assert.equal(monday.phase, 'oficial');
  for (const d of days.filter(d => !d.isLaunch)) assert.equal(weekdayOf(d.date), weekdayOf(d.refDate));
});

test('alignEventDays: launch day compares against last year launch day', () => {
  const days = alignEventDays(EVENTS.cyber.current, EVENTS.cyber.previous);
  assert.deepEqual(days[0], { date: '2026-10-29', refDate: '2025-10-29', phase: 'pre', isLaunch: true });
  assert.equal(days[1].refDate, '2025-10-31');
  assert.equal(days.at(-1).date, '2026-11-15');
  assert.equal(days.at(-1).phase, 'extension');
  assert.equal(days.length, 18);
});

test('projectInflationIndex: published month returned as-is', () => {
  const idx = new Map([['2026-05', 100], ['2026-06', 102], ['2026-07', 104], ['2026-08', 106]]);
  assert.deepEqual(projectInflationIndex(idx, '2026-07'), { index: 104, projected: false });
});

test('projectInflationIndex: missing month compounds the last 3 months average rate', () => {
  const idx = new Map([['2026-05', 100], ['2026-06', 110], ['2026-07', 121], ['2026-08', 133.1]]);
  const r = projectInflationIndex(idx, '2026-10');
  assert.equal(r.projected, true);
  assert.ok(Math.abs(r.index - 161.051) < 1e-6);
});

test('inflationFactor: ratio of target to reference month', () => {
  const idx = new Map([['2025-11', 100], ['2026-11', 132]]);
  assert.deepEqual(inflationFactor(idx, '2025-11', '2026-11'), { factor: 1.32, projected: false });
});

test('weekdayBaseline: averages per weekday, counting empty days as zero', () => {
  // 2026-09-07 is a Monday
  const map = new Map([['2026-09-07', { revenue: 100, orders: 1 }]]);
  const b = weekdayBaseline(map, '2026-09-07', '2026-09-20');
  assert.equal(b[1], 50);
  assert.equal(b[2], 0);
});

function sale(channel, iso, total, status = 'completed') {
  return { channel, date: iso, total, status, items: [] };
}

test('buildEventDays: target = last year aligned day × inflation × growth; no-history channel uses baseline', () => {
  const current = { start: '2026-11-02', end: '2026-11-03', officialStart: '2026-11-02', officialEnd: '2026-11-03' };
  const previous = { start: '2025-11-03', end: '2025-11-04', officialStart: '2025-11-03', officialEnd: '2025-11-04' };
  const prevDaily = dailyByChannel([
    sale('ecommerce', '2025-11-03T15:00:00Z', 1000),
    sale('local_lomas', '2025-11-03T15:00:00Z', 200),
    sale('ecommerce', '2025-11-03T16:00:00Z', 999, 'cancelled'),
  ]);
  const currentDaily = dailyByChannel([sale('ecommerce', '2026-11-02T15:00:00Z', 1500)]);
  // Alcorta: 8 weeks before 2026-11-02 → only Mondays sold 80 each
  const baselineDocs = [];
  for (let i = 1; i <= 8; i++) {
    const d = new Date(Date.UTC(2026, 10, 2 - 7 * i, 15));
    baselineDocs.push(sale('local_alcorta', d.toISOString(), 80));
  }
  const res = buildEventDays({
    current, previous, prevDaily, currentDaily,
    baselineDaily: dailyByChannel(baselineDocs),
    indexByMonth: new Map([['2025-11', 100], ['2026-11', 130]]),
    growth: { web: 0.1, locales: 0.05 },
    today: '2026-11-02',
  });
  const [mon, tue] = res.days;
  assert.ok(Math.abs(mon.web.target - 1000 * 1.3 * 1.1) < 1e-6);
  assert.equal(mon.web.revenue, 1500);
  assert.ok(Math.abs(mon.locales.target - (200 * 1.3 * 1.05 + 80)) < 1e-6);
  assert.equal(tue.web.revenue, null);
  assert.equal(tue.played, false);
  assert.deepEqual(res.channelsWithoutHistory, ['local_belgrano', 'local_alcorta']);
  assert.equal(res.totals.web.revenue, 1500);
  assert.ok(Math.abs(res.totals.web.targetToDate - 1430) < 1e-6);
});

test('summarizePastEvent: peak day, lift vs normal days, official share and hourly in ART', () => {
  const window = { start: '2025-11-02', end: '2025-11-03', officialStart: '2025-11-03', officialEnd: '2025-11-03' };
  const docs = [
    sale('ecommerce', '2025-11-02T15:00:00Z', 100),
    sale('ecommerce', '2025-11-03T23:30:00Z', 300), // 20:30 ART
  ];
  const baseline = [sale('ecommerce', '2025-10-20T15:00:00Z', 50), sale('ecommerce', '2025-10-21T15:00:00Z', 50)];
  const r = summarizePastEvent(docs, baseline, window);
  assert.equal(r.revenue, 400);
  assert.equal(r.peakDay.date, '2025-11-03');
  assert.equal(r.lift, 4);
  assert.equal(r.officialSharePct, 75);
  assert.equal(r.hourly[20].revenue, 300);
});

test('baselineRange: 8 weeks ending the day before the event, or yesterday if the event is further away', () => {
  assert.deepEqual(baselineRange({ start: '2026-10-29' }, '2026-11-20'), { start: '2026-09-03', end: '2026-10-28' });
  assert.deepEqual(baselineRange({ start: '2026-11-26' }, '2026-10-27'), { start: '2026-09-01', end: '2026-10-26' });
});
