import { describe, it, expect } from 'vitest';
import { TABS, parseUrlState, serializeUrlState, periodParams } from './urlState.js';

const TODAY = '2026-11-12';
const DEFAULT = { tab: 'resumen', period: 'week', date: TODAY, start: null, end: null };

describe('urlState', () => {
  it('lists the tabs, without feria', () => {
    expect(TABS).toEqual(['resumen', 'web', 'locales', 'producto', 'pauta', 'mayorista', 'cyber']);
  });

  it('defaults to Resumen, this week', () => {
    expect(parseUrlState('?v=nuevo', TODAY)).toEqual(DEFAULT);
  });

  it('reads tab, period and date', () => {
    expect(parseUrlState('?v=nuevo&tab=producto&period=month&date=2026-10-01', TODAY))
      .toEqual({ tab: 'producto', period: 'month', date: '2026-10-01', start: null, end: null });
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
    const s = { tab: 'web', period: 'custom', date: TODAY, start: '2026-10-01', end: '2026-10-15' };
    const qs = serializeUrlState(s);
    expect(qs.startsWith('?v=nuevo')).toBe(true);
    expect(parseUrlState(qs, TODAY)).toEqual(s);
  });

  it('round-trips a month', () => {
    const s = { tab: 'locales', period: 'month', date: '2026-10-01', start: null, end: null };
    expect(parseUrlState(serializeUrlState(s), TODAY)).toEqual(s);
  });

  it('builds the API params', () => {
    expect(periodParams(DEFAULT)).toEqual({ period: 'week', date: TODAY });
    expect(periodParams({ ...DEFAULT, period: 'custom', start: '2026-10-01', end: '2026-10-15' }))
      .toEqual({ period: 'custom', start: '2026-10-01', end: '2026-10-15' });
  });
});
