import { describe, it, expect } from 'vitest';
import { TABS, parseUrlState, serializeUrlState, periodParams } from './urlState.js';

const TODAY = '2026-11-12';
const DEFAULT = { tab: 'resumen', period: 'week', date: TODAY, start: null, end: null, sku: null, ch: 'all', loc: 'lomas' };

describe('urlState', () => {
  it('lists the tabs, without feria', () => {
    expect(TABS).toEqual(['resumen', 'web', 'locales', 'producto', 'pauta', 'mayorista', 'cyber']);
  });

  it('defaults to Resumen, this week', () => {
    expect(parseUrlState('?v=nuevo', TODAY)).toEqual(DEFAULT);
  });

  it('reads tab, period and date', () => {
    expect(parseUrlState('?v=nuevo&tab=producto&period=month&date=2026-10-01', TODAY))
      .toEqual({ tab: 'producto', period: 'month', date: '2026-10-01', start: null, end: null, sku: null, ch: 'all', loc: 'lomas' });
  });

  it('falls back to defaults on junk', () => {
    expect(parseUrlState('?v=nuevo&tab=feria', TODAY)).toEqual(DEFAULT);
    expect(parseUrlState('?v=nuevo&date=2026-13-45', TODAY)).toEqual(DEFAULT);
    expect(parseUrlState('?v=nuevo&period=custom&start=2026-11-10&end=2026-11-01', TODAY)).toEqual(DEFAULT);
    expect(parseUrlState('?v=nuevo&period=year', TODAY)).toEqual(DEFAULT);
  });

  it('keeps the tab when only the period is junk', () => {
    expect(parseUrlState('?v=nuevo&tab=web&period=custom&start=x', TODAY)).toEqual({ ...DEFAULT, tab: 'web' });
  });

  it('round-trips a custom range', () => {
    const s = { tab: 'web', period: 'custom', date: TODAY, start: '2026-10-01', end: '2026-10-15', sku: null, ch: 'all', loc: 'lomas' };
    const qs = serializeUrlState(s);
    expect(qs.startsWith('?v=nuevo')).toBe(true);
    expect(parseUrlState(qs, TODAY)).toEqual(s);
  });

  it('round-trips a month', () => {
    const s = { tab: 'locales', period: 'month', date: '2026-10-01', start: null, end: null, sku: 'MSI018VE', ch: 'mayorista', loc: 'alcorta' };
    expect(parseUrlState(serializeUrlState(s), TODAY)).toEqual(s);
  });

  it('builds the API params', () => {
    expect(periodParams(DEFAULT)).toEqual({ period: 'week', date: TODAY });
    expect(periodParams({ ...DEFAULT, period: 'custom', start: '2026-10-01', end: '2026-10-15' }))
      .toEqual({ period: 'custom', start: '2026-10-01', end: '2026-10-15' });
  });

  it('keeps an open product only if the SKU looks like one', () => {
    expect(parseUrlState('?v=nuevo&sku=MSI018VE', TODAY).sku).toBe('MSI018VE');
    expect(parseUrlState('?v=nuevo&sku=%3Cscript%3E', TODAY).sku).toBe(null);
    expect(serializeUrlState({ ...DEFAULT, sku: null })).not.toContain('sku');
  });

  it('reads the Producto channel filter; junk falls back to all', () => {
    expect(parseUrlState('?v=nuevo&tab=producto&ch=web', TODAY).ch).toBe('web');
    expect(parseUrlState('?v=nuevo&tab=producto&ch=locales', TODAY).ch).toBe('locales');
    expect(parseUrlState('?v=nuevo&ch=xx', TODAY).ch).toBe('all');
  });

  it('serializes ch only when it is not all', () => {
    expect(serializeUrlState({ ...DEFAULT, tab: 'producto', ch: 'web' })).toContain('ch=web');
    expect(serializeUrlState({ ...DEFAULT, tab: 'producto' })).not.toContain('ch=');
    const s = { ...DEFAULT, tab: 'producto', ch: 'locales' };
    expect(parseUrlState(serializeUrlState(s), TODAY)).toEqual(s);
  });

  it('loc defaults to lomas and stays out of the URL', () => {
    expect(parseUrlState('?v=nuevo&tab=locales', TODAY).loc).toBe('lomas');
    expect(serializeUrlState({ ...DEFAULT, tab: 'locales' })).not.toContain('loc=');
  });

  it('loc=belgrano round-trips', () => {
    const url = serializeUrlState({ ...DEFAULT, tab: 'locales', loc: 'belgrano' });
    expect(url).toContain('loc=belgrano');
    expect(parseUrlState(url, TODAY).loc).toBe('belgrano');
  });

  it('unknown loc falls back to lomas', () => {
    expect(parseUrlState('?v=nuevo&tab=locales&loc=xx', TODAY).loc).toBe('lomas');
  });
});
