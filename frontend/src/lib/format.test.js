import { describe, test, expect } from 'vitest';
import { formatCurrency, formatNumber, formatPercent, formatRate, formatRoas } from './format.js';

test('formatCurrency formats ARS with no decimals and thousands separators', () => {
  expect(formatCurrency(105653226.14)).toBe('$ 105.653.226');
});

test('formatCurrency handles zero', () => {
  expect(formatCurrency(0)).toBe('$ 0');
});

test('formatNumber formats with a thousands separator', () => {
  expect(formatNumber(1872)).toBe('1.872');
});

test('formatNumber formats small numbers without a separator', () => {
  expect(formatNumber(42)).toBe('42');
});

test('formatPercent adds a plus sign for positive values, one decimal place', () => {
  expect(formatPercent(51.8)).toBe('+51.8%');
});

test('formatPercent keeps the minus sign for negative values, one decimal place', () => {
  expect(formatPercent(-51.78)).toBe('-51.8%');
});

test('formatPercent returns an em dash for null (no comparison baseline)', () => {
  expect(formatPercent(null)).toBe('—');
});

test('formatPercent returns an em dash for undefined', () => {
  expect(formatPercent(undefined)).toBe('—');
});

test('formatRate shows a plain percentage with no forced sign, one decimal place', () => {
  expect(formatRate(4.2)).toBe('4.2%');
});

test('formatRate returns an em dash for null', () => {
  expect(formatRate(null)).toBe('—');
});

test('formatRoas shows two decimals with an x suffix', () => {
  expect(formatRoas(4.812089)).toBe('4.81x');
});

test('formatRoas returns an em dash for null', () => {
  expect(formatRoas(null)).toBe('—');
});
