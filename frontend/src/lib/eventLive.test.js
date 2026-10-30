import { describe, test, expect, beforeEach } from 'vitest';
import {
  STATUS_LABELS, MILESTONE_COPY, groupView, milestoneText, crossedMilestones, minutesAgo,
  loadSeen, markSeen, compactMoney,
} from './eventLive.js';

function cell(over = {}) {
  return { prevRevenue: 0, prevOrders: 0, floor: 0, target: 0, revenue: null, orders: null, ...over };
}

function fixture() {
  return {
    label: 'Cyber',
    today: '2026-10-30',
    days: [
      {
        date: '2026-10-29', played: true,
        web: cell({ prevRevenue: 80, floor: 100, target: 110, revenue: 120, orders: 3 }),
        locales: cell({ prevRevenue: 40, floor: 50, target: 55, revenue: 30, orders: 2 }),
      },
      {
        date: '2026-10-30', played: true,
        web: cell({ prevRevenue: 160, floor: 200, target: 220, revenue: 90, orders: 4 }),
        locales: cell({ prevRevenue: 80, floor: 100, target: 105, revenue: 10, orders: 1 }),
      },
      {
        date: '2026-10-31', played: false,
        web: cell({ prevRevenue: 160, floor: 200, target: 220 }),
        locales: cell({ prevRevenue: 80, floor: 100, target: 105 }),
      },
    ],
    totals: {
      web: { prevRevenue: 400, floor: 500, floorToDate: 300, target: 550, targetToDate: 330, revenue: 210, orders: 7, status: 'bajo_piso' },
      locales: { prevRevenue: 200, floor: 250, floorToDate: 150, target: 265, targetToDate: 160, revenue: 40, orders: 3, status: 'bajo_piso' },
    },
    live: {
      todayShare: { web: 0.5, locales: 0.25 },
      todayStatus: { web: { pct: 81.8, status: 'bajo_piso' }, locales: { pct: 38.1, status: 'bajo_piso' }, total: { pct: 60, status: 'bajo_piso' } },
      projection: { web: 600, locales: 200, total: 800 },
      topProductToday: { name: 'Silla Tube', units: 12 },
      peakHourYesterday: { hour: 21, revenue: 14_000_000 },
      categories: [
        { id: 'sillas', label: 'Sillas', stock: 60, cantMatch: true },
        { id: 'textil', label: 'Textil', stock: 1200, cantMatch: false },
        { id: 'escritorios', label: 'Escritorios', stock: 8, cantMatch: true },
        { id: 'otros', label: 'Otros', stock: 0, cantMatch: true },
      ],
    },
  };
}

function view(over = {}) {
  return {
    revenue: 0, floor: 1000, target: 1100,
    today: { date: '2026-10-30', revenue: 0, floor: 100, target: 110 },
    ...over,
  };
}

describe('STATUS_LABELS / MILESTONE_COPY', () => {
  test('carry the exact copy', () => {
    expect(STATUS_LABELS).toEqual({ bajo_piso: 'bajo piso', entre: 'entre piso y obj.', sobre: 'sobre obj.' });
    expect(MILESTONE_COPY.piso_dia).toBe('¡Pasamos el piso de HOY!');
    expect(MILESTONE_COPY.objetivo_dia).toBe('¡Pasamos el objetivo de HOY!');
    expect(MILESTONE_COPY.piso_evento).toBe('¡Pasamos el PISO del {label}!');
    expect(MILESTONE_COPY.objetivo_evento).toBe('¡OBJETIVO del {label} cumplido!');
  });
});

describe('groupView', () => {
  test('web reads the web totals and today row', () => {
    const v = groupView(fixture(), 'web');
    expect(v.revenue).toBe(210);
    // 100 + 200×0.5 floor elapsed, 110 + 220×0.5 target elapsed
    expect(v.floorElapsed).toBe(200);
    expect(v.targetElapsed).toBe(220);
    expect(v.status).toBe('entre');
    expect(v.projection).toBe(600);
    expect(v.today).toMatchObject({ date: '2026-10-30', revenue: 90, floor: 200, target: 220, pct: 81.8, status: 'bajo_piso' });
    // 2025 same day, inflation-adjusted (floor), up to the elapsed share of today.
    expect(v.todayPrev).toBe(100);
  });

  test('total sums web + locales', () => {
    const v = groupView(fixture(), 'total');
    expect(v).toMatchObject({
      revenue: 250, orders: 10, floor: 750, target: 815, floorToDate: 450, targetToDate: 490, prevRevenue: 600,
      projection: 800,
    });
    expect(v.today).toMatchObject({ revenue: 100, floor: 300, target: 325, pct: 60, status: 'bajo_piso' });
    expect(v.todayPrev).toBe(200 * 0.5 + 100 * 0.25);
    // each group with its own share: web 200/220, locales 50+25 / 55+26.25
    expect(v.floorElapsed).toBe(275);
    expect(v.targetElapsed).toBe(301.25);
    expect(v.status).toBe('bajo_piso');
  });

  test('total status is null when nothing to compare yet', () => {
    const d = fixture();
    d.days.forEach(day => { day.played = false; });
    expect(groupView(d, 'total').status).toBeNull();
    expect(groupView(d, 'web').status).toBeNull();
  });

  test('mid-day: 55% of the full-day target at half the day is not bajo_piso', () => {
    const d = {
      label: 'Cyber', today: '2026-11-02',
      days: [{ date: '2026-11-02', played: true, web: cell({ floor: 100, target: 110, revenue: 60.5, orders: 2 }), locales: cell({ floor: 50, target: 52.5, revenue: 28.875, orders: 1 }) }],
      totals: {
        web: { floor: 100, floorToDate: 100, target: 110, targetToDate: 110, revenue: 60.5, orders: 2, status: 'bajo_piso' },
        locales: { floor: 50, floorToDate: 50, target: 52.5, targetToDate: 52.5, revenue: 28.875, orders: 1, status: 'bajo_piso' },
      },
      live: { todayShare: { web: 0.5, locales: 0.5 } },
    };
    expect(groupView(d, 'web').status).not.toBe('bajo_piso');
    expect(groupView(d, 'web').status).toBe('sobre');
    expect(groupView(d, 'locales').status).not.toBe('bajo_piso');
    expect(groupView(d, 'total').status).not.toBe('bajo_piso');
  });

  test('outside the window today has no revenue and no status', () => {
    const d = fixture();
    d.today = '2026-11-20';
    d.live.todayStatus = { web: null, locales: null, total: null };
    const v = groupView(d, 'web');
    expect(v.today).toMatchObject({ revenue: null, floor: 0, target: 0, pct: null, status: null });
    expect(v.todayPrev).toBe(0);
  });
});

describe('crossedMilestones', () => {
  test('first load fires only the milestones already reached', () => {
    const next = view({ revenue: 1050, today: { date: '2026-10-30', revenue: 105, floor: 100, target: 110 } });
    expect(crossedMilestones(null, next)).toEqual(['piso_dia', 'piso_evento']);
  });

  test('does not repeat a milestone the previous value already passed', () => {
    const prev = view({ revenue: 1050, today: { date: '2026-10-30', revenue: 105, floor: 100, target: 110 } });
    const next = view({ revenue: 1200, today: { date: '2026-10-30', revenue: 120, floor: 100, target: 110 } });
    expect(crossedMilestones(prev, next)).toEqual(['objetivo_dia', 'objetivo_evento']);
  });

  test('zero thresholds never fire', () => {
    const next = view({ revenue: 50, floor: 0, target: 0, today: { date: '2026-10-30', revenue: 5, floor: 0, target: 0 } });
    expect(crossedMilestones(null, next)).toEqual([]);
  });

  test('null today revenue counts as nothing sold', () => {
    const next = view({ today: { date: '2026-10-30', revenue: null, floor: 100, target: 110 } });
    expect(crossedMilestones(null, next)).toEqual([]);
  });

  test('a new day compares today from scratch', () => {
    const prev = view({ today: { date: '2026-10-29', revenue: 500, floor: 100, target: 110 } });
    const next = view({ today: { date: '2026-10-30', revenue: 105, floor: 100, target: 110 } });
    expect(crossedMilestones(prev, next)).toEqual(['piso_dia']);
  });
});

describe('milestoneText', () => {
  test('names the view outside Total', () => {
    expect(milestoneText('piso_dia', 'Cyber')).toBe('¡Pasamos el piso de HOY!');
    expect(milestoneText('piso_dia', 'Cyber', 'total')).toBe('¡Pasamos el piso de HOY!');
    expect(milestoneText('objetivo_evento', 'Black', 'locales')).toBe('¡OBJETIVO del Black cumplido! (locales)');
  });
});

describe('minutesAgo', () => {
  test('whole minutes since the timestamp, never negative', () => {
    const now = Date.parse('2026-10-30T13:45:00Z');
    expect(minutesAgo('2026-10-30T13:39:30Z', now)).toBe(5);
    expect(minutesAgo('2026-10-30T13:50:00Z', now)).toBe(0);
    expect(minutesAgo(null, now)).toBeNull();
  });
});

describe('compactMoney', () => {
  test('millions with a comma decimal under 10M, thousands as K', () => {
    expect(compactMoney(14_000_000)).toBe('$14M');
    expect(compactMoney(6_685_618)).toBe('$6,7M');
    expect(compactMoney(321_400)).toBe('$321K');
    expect(compactMoney(950)).toBe('$950');
    expect(compactMoney(1_156_457_237)).toBe('$1.156M');
  });
});

describe('seen milestones', () => {
  beforeEach(() => {
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
  });

  test('markSeen persists per event', () => {
    expect(loadSeen('cyber').size).toBe(0);
    markSeen('cyber', 'total:piso_evento');
    expect(loadSeen('cyber').has('total:piso_evento')).toBe(true);
    expect(loadSeen('black').size).toBe(0);
  });

  test('broken storage does not throw', () => {
    globalThis.sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadSeen('cyber').size).toBe(0);
    expect(() => markSeen('cyber', 'x')).not.toThrow();
  });
});
