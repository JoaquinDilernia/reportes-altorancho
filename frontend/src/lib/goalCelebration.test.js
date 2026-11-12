import { describe, it, expect } from 'vitest';
import { goalStatus, wasCelebrated, markCelebrated, forcedByUrl } from './goalCelebration.js';

const data = (web, locales) => ({
  event: 'cyber', label: 'Cyber', current: { year: 2026 }, today: '2026-11-12', days: [],
  totals: { web: { revenue: web[0], target: web[1] }, locales: { revenue: locales[0], target: locales[1] } },
});

describe('goalStatus', () => {
  it('usa el total (web + locales) aunque una sola vista pase', () => {
    expect(goalStatus(data([120, 100], [10, 50])).passed).toBe(false);
  });
  it('pasa cuando lo facturado llega al objetivo, con el % por encima', () => {
    const s = goalStatus(data([100, 100], [65, 50]));
    expect(s).toMatchObject({ passed: true, revenue: 165, target: 150 });
    expect(s.overPct).toBeCloseTo(10);
  });
  it('sin objetivo no festeja', () => {
    expect(goalStatus(data([5, 0], [5, 0])).passed).toBe(false);
  });
});

describe('wasCelebrated / markCelebrated', () => {
  const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
  it('una vez por navegador y por evento', () => {
    const s = store();
    expect(wasCelebrated(s, 'cyber', 2026)).toBe(false);
    markCelebrated(s, 'cyber', 2026);
    expect(wasCelebrated(s, 'cyber', 2026)).toBe(true);
    expect(wasCelebrated(s, 'black', 2026)).toBe(false);
  });
  it('si el storage está bloqueado no rompe (festeja igual)', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(wasCelebrated(broken, 'cyber', 2026)).toBe(false);
    expect(() => markCelebrated(broken, 'cyber', 2026)).not.toThrow();
  });
});

describe('forcedByUrl', () => {
  it('?festejo=1 lo muestra para probarlo', () => {
    expect(forcedByUrl('?tab=cyber&festejo=1')).toBe(true);
    expect(forcedByUrl('?tab=cyber')).toBe(false);
  });
});
