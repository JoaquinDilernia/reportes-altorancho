import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampGa4DateRanges } from '../ga4.mjs';

// GA4 answers 400 "Future currency exchange rate not exist" when a range with
// revenue metrics ends after today (e.g. the running month up to the 30th).
test('clampGa4DateRanges: un rango que termina en el futuro se corta en hoy', () => {
  const body = { dateRanges: [{ startDate: '2026-11-01', endDate: '2026-11-30', name: 'cur' }], metrics: [{ name: 'purchaseRevenue' }] };
  const out = clampGa4DateRanges(body, '2026-11-12');
  assert.deepEqual(out.dateRanges, [{ startDate: '2026-11-01', endDate: '2026-11-12', name: 'cur' }]);
  assert.deepEqual(out.metrics, body.metrics);
});

test('clampGa4DateRanges: los rangos pasados no cambian', () => {
  const body = { dateRanges: [{ startDate: '2025-11-01', endDate: '2025-11-30' }, { startDate: '2026-10-01', endDate: '2026-10-31' }] };
  assert.deepEqual(clampGa4DateRanges(body, '2026-11-12').dateRanges, body.dateRanges);
});

test('clampGa4DateRanges: un cuerpo sin dateRanges pasa igual', () => {
  assert.deepEqual(clampGa4DateRanges({ metrics: [] }, '2026-11-12'), { metrics: [] });
});
