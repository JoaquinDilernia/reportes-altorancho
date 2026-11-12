import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeClarityPages, clarityForPeriod } from '../clarityPeriod.mjs';

const sig = (pct, count) => ({ pct, sessions: 0, count });
const snap = (date, { sessions, scroll, active = 60, rage, pages = [] }) => ({
  date,
  totals: {
    sessions, users: sessions, pagesPerSession: 2, scrollDepth: scroll, totalTimeSec: 100, activeTimeSec: active,
    signals: { rage, dead: sig(10, 1), quickback: sig(20, 1), errorClick: null, excessiveScroll: null, scriptError: null },
  },
  pages,
});
const RANGE = { start: '2026-11-09', end: '2026-11-15' };

test('mergeClarityPages: weights by sessions across days', () => {
  const pages = mergeClarityPages([
    { pages: [{ path: '/', sessions: 100, scrollDepth: 40, rage: 10, dead: 0, quickback: 0 }] },
    { pages: [{ path: '/', sessions: 300, scrollDepth: 60, rage: 0, dead: 0, quickback: 0 }] },
  ]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].sessions, 400);
  assert.equal(pages[0].rage, 2.5);
  assert.equal(pages[0].scrollDepth, 55);
});

test('clarityForPeriod: 2 of 7 days, totals weighted', () => {
  const c = clarityForPeriod([
    snap('2026-11-10', { sessions: 100, scroll: 40, rage: sig(1, 3) }),
    snap('2026-11-11', { sessions: 300, scroll: 60, rage: sig(3, 9) }),
  ], RANGE);
  assert.equal(c.days, 2);
  assert.equal(c.totalDays, 7);
  assert.deepEqual(c.dates, ['2026-11-10', '2026-11-11']);
  assert.equal(c.totals.sessions, 400);
  assert.equal(c.totals.scrollDepth, 55);
  assert.deepEqual(c.totals.signals.rage, { pct: 2.5, count: 12 });
  assert.equal(c.daily.length, 2);
  assert.deepEqual(c.daily[0], { date: '2026-11-10', sessions: 100, rage: 1, dead: 10, quickback: 20 });
});

test('clarityForPeriod: no snapshots → only days and totalDays', () => {
  assert.deepEqual(clarityForPeriod([], RANGE), { days: 0, totalDays: 7 });
  assert.deepEqual(clarityForPeriod(null, RANGE), { days: 0, totalDays: 7 });
});

test('clarityForPeriod: a signal null every day stays null; small pages not listed', () => {
  const c = clarityForPeriod([
    snap('2026-11-10', { sessions: 100, scroll: 40, rage: null, pages: [
      { path: '/', sessions: 80, scrollDepth: 50, rage: 0, dead: 0, quickback: 0 },
      { path: '/chico', sessions: 10, scrollDepth: 50, rage: 0, dead: 0, quickback: 0 },
    ] }),
  ], RANGE);
  assert.equal(c.totals.signals.rage, null);
  assert.equal(c.totals.signals.excessiveScroll, null);
  assert.deepEqual(c.pages.map(p => p.path), ['/']);
});

test('clarityForPeriod: a running period only counts days already closed', () => {
  const c = clarityForPeriod([snap('2026-11-10', { sessions: 100, scroll: 40, rage: sig(1, 3) })], RANGE, { today: '2026-11-12' });
  assert.equal(c.totalDays, 3); // 9, 10, 11 — today's snapshot is taken tomorrow
  assert.equal(c.running, true);
  assert.deepEqual(clarityForPeriod([], RANGE, { today: '2026-11-09' }), { days: 0, totalDays: 0, running: true });
  assert.equal(clarityForPeriod([], RANGE, { today: '2026-11-20' }).totalDays, 7);
});
