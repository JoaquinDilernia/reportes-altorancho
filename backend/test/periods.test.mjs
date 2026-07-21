import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPeriodRanges } from '../periods.mjs';

// 2024-01-01 was a Monday (verified calendar fact) — used as a safe anchor.
test('week period: anchor mid-week resolves to Monday-Sunday', () => {
  const { current } = getPeriodRanges('2024-01-03', 'week'); // Wednesday
  assert.deepEqual(current, { start: '2024-01-01', end: '2024-01-07' });
});

test('week period: prevPeriod is the 7 days before', () => {
  const { prevPeriod } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevPeriod, { start: '2023-12-25', end: '2023-12-31' });
});

test('week period: prevMonth shifts the same range back one calendar month', () => {
  const { prevMonth } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevMonth, { start: '2023-12-01', end: '2023-12-07' });
});

test('week period: prevYear shifts the same range back one year', () => {
  const { prevYear } = getPeriodRanges('2024-01-03', 'week');
  assert.deepEqual(prevYear, { start: '2023-01-01', end: '2023-01-07' });
});

test('month period: current spans the full calendar month', () => {
  const { current } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(current, { start: '2024-01-01', end: '2024-01-31' });
});

test('month period: prevPeriod is the previous calendar month', () => {
  const { prevPeriod } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(prevPeriod, { start: '2023-12-01', end: '2023-12-31' });
});

test('month period: prevYear is the same month one year back', () => {
  const { prevYear } = getPeriodRanges('2024-01-15', 'month');
  assert.deepEqual(prevYear, { start: '2023-01-01', end: '2023-01-31' });
});

test('unknown period throws', () => {
  assert.throws(() => getPeriodRanges('2024-01-15', 'day'));
});

test('custom period: current is the given start/end verbatim', () => {
  const { current } = getPeriodRanges('2024-01-10', 'custom', '2024-01-16');
  assert.deepEqual(current, { start: '2024-01-10', end: '2024-01-16' });
});

test('custom period: prevPeriod is the preceding window of the same length', () => {
  const { prevPeriod } = getPeriodRanges('2024-01-10', 'custom', '2024-01-16');
  assert.deepEqual(prevPeriod, { start: '2024-01-03', end: '2024-01-09' });
});

test('custom period: prevMonth shifts both ends back one calendar month', () => {
  const { prevMonth } = getPeriodRanges('2024-01-10', 'custom', '2024-01-16');
  assert.deepEqual(prevMonth, { start: '2023-12-10', end: '2023-12-16' });
});

test('custom period: prevYear shifts both ends back one year', () => {
  const { prevYear } = getPeriodRanges('2024-01-10', 'custom', '2024-01-16');
  assert.deepEqual(prevYear, { start: '2023-01-10', end: '2023-01-16' });
});

test('custom period without an end date throws', () => {
  assert.throws(() => getPeriodRanges('2024-01-10', 'custom'));
});

test('month period: prevMonth clamps to the shorter target month (31-day month anchor)', () => {
  const { prevMonth } = getPeriodRanges('2024-03-15', 'month');
  assert.deepEqual(prevMonth, { start: '2024-02-01', end: '2024-02-29' });
});

test('month period: prevYear clamps Feb 29 to Feb 28 in a non-leap target year', () => {
  const { prevYear } = getPeriodRanges('2024-02-15', 'month');
  assert.deepEqual(prevYear, { start: '2023-02-01', end: '2023-02-28' });
});
