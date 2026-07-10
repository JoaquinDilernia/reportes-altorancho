import { test, expect } from 'vitest';
import { shiftPeriod, formatPeriodLabel } from './periods.js';

test('shiftPeriod week moves the anchor forward 7 days', () => {
  expect(shiftPeriod('2026-07-06', 'week', 1)).toBe('2026-07-13');
});

test('shiftPeriod week moves the anchor backward 7 days', () => {
  expect(shiftPeriod('2026-07-06', 'week', -1)).toBe('2026-06-29');
});

test('shiftPeriod month normalizes to the 1st of the next month regardless of anchor day', () => {
  expect(shiftPeriod('2026-01-31', 'month', 1)).toBe('2026-02-01');
});

test('shiftPeriod month normalizes to the 1st of the previous month across a year boundary', () => {
  expect(shiftPeriod('2026-01-15', 'month', -1)).toBe('2025-12-01');
});

test('formatPeriodLabel week formats a Monday-Sunday range within the same month', () => {
  // 2026-07-06 is a Monday (verified); week is Jul 6-12.
  expect(formatPeriodLabel('2026-07-08', 'week')).toBe('6 – 12 jul 2026');
});

test('formatPeriodLabel week formats a range spanning two months', () => {
  // 2026-06-29 is a Monday (verified); week is Jun 29 - Jul 5.
  expect(formatPeriodLabel('2026-06-30', 'week')).toBe('29 jun – 5 jul 2026');
});

test('formatPeriodLabel month formats the full month name and year', () => {
  expect(formatPeriodLabel('2026-07-08', 'month')).toBe('Julio 2026');
});
