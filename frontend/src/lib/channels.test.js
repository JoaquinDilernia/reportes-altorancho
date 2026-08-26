import { test, expect } from 'vitest';
import { CHANNELS, getChannelColor, getChannelLabel } from './channels.js';

test('CHANNELS lists all six channels with hex colors matching the design tokens', () => {
  expect(CHANNELS).toEqual([
    { id: 'ecommerce', label: 'Ecommerce', color: '#1BAF7A' },
    { id: 'local_lomas', label: 'Lomas', color: '#008300' },
    { id: 'local_belgrano', label: 'Belgrano', color: '#4A3AA7' },
    { id: 'local_alcorta', label: 'Alcorta', color: '#EB6834' },
    { id: 'mayorista', label: 'Mayorista', color: '#2A78D6' },
    { id: 'feria', label: 'Feria', color: '#0E9594' },
  ]);
});

test('getChannelColor returns the mapped color for a known channel', () => {
  expect(getChannelColor('mayorista')).toBe('#2A78D6');
});

test('getChannelColor returns the neutral ink color for null (consolidado)', () => {
  expect(getChannelColor(null)).toBe('#353434');
});

test('getChannelLabel returns "Consolidado" for null', () => {
  expect(getChannelLabel(null)).toBe('Consolidado');
});

test('getChannelLabel returns the mapped label for a known channel', () => {
  expect(getChannelLabel('local_belgrano')).toBe('Belgrano');
});
