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
