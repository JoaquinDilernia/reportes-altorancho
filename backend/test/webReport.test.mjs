import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webPlan } from '../webReport.mjs';

const ranges = {
  current: { start: '2026-11-09', end: '2026-11-15' },
  prevPeriod: { start: '2026-11-02', end: '2026-11-08' },
  prevYear: { start: '2025-11-09', end: '2025-11-15' },
};

test('webPlan: closed week → GA4 yoy is the full prev-year week (same cache key as the Resumen)', () => {
  const p = webPlan(ranges, '2026-11-20');
  assert.equal(p.prevRange.partial, false);
  assert.deepEqual(p.gaRanges.yoy, ranges.prevYear);
  assert.deepEqual(p.gaRanges.cur, ranges.current);
  assert.deepEqual(p.gaRanges.prev, ranges.prevPeriod);
});

test('webPlan: running week on Wednesday → prev-year cut to Mon–Wed', () => {
  const p = webPlan(ranges, '2026-11-11');
  assert.deepEqual(p.prevRange, { start: '2025-11-09', end: '2025-11-11', partial: true });
  assert.deepEqual(p.gaRanges.yoy, { start: '2025-11-09', end: '2025-11-11' });
});

test('webPlan: running week → the previous week is cut to the same elapsed days too', () => {
  const p = webPlan(ranges, '2026-11-11');
  assert.deepEqual(p.prevPeriodRange, { start: '2026-11-02', end: '2026-11-04', partial: true });
  assert.deepEqual(p.gaRanges.prev, { start: '2026-11-02', end: '2026-11-04' });
});

test('webPlan: closed week → previous week whole (same GA4 cache key as the Resumen)', () => {
  const p = webPlan(ranges, '2026-11-20');
  assert.deepEqual(p.prevPeriodRange, { ...ranges.prevPeriod, partial: false });
  assert.deepEqual(p.gaRanges.prev, ranges.prevPeriod);
});

test('webPlan: late March never reaches into March for "mes ant."', () => {
  const march = {
    current: { start: '2026-03-01', end: '2026-03-31' },
    prevPeriod: { start: '2026-02-01', end: '2026-02-28' },
    prevYear: { start: '2025-03-01', end: '2025-03-31' },
  };
  const p = webPlan(march, '2026-03-30');
  assert.equal(p.prevPeriodRange.end, '2026-02-28');
  assert.equal(p.gaRanges.prev.end, '2026-02-28');
});
