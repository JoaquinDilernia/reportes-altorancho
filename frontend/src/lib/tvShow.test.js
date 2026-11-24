import { describe, it, expect } from 'vitest';
import { tierOf, newSales, feedIds, liveTotals } from './tvShow.js';

describe('tierOf', () => {
  it('splits by the amount shown', () => {
    expect(tierOf(499_999)).toBe(0);
    expect(tierOf(500_000)).toBe(1);
    expect(tierOf(999_999)).toBe(1);
    expect(tierOf(1_000_000)).toBe(2);
    expect(tierOf(1_500_000)).toBe(3);
    expect(tierOf(2_000_000)).toBe(4);
    expect(tierOf(9_000_000)).toBe(4);
    expect(tierOf(null)).toBe(0);
  });
});

describe('newSales', () => {
  const feed = [
    { id: 'b', date: '2026-11-27T12:00:00Z', total: 1 },
    { id: 'a', date: '2026-11-27T11:00:00Z', total: 1 },
  ];
  it('first poll only learns what is there (no replay on open)', () => {
    expect(newSales(null, feed)).toEqual([]);
  });
  it('returns unseen sales oldest first', () => {
    const seen = feedIds([{ id: 'x' }]);
    expect(newSales(seen, feed).map(s => s.id)).toEqual(['a', 'b']);
    expect(newSales(feedIds(feed, seen), feed)).toEqual([]);
  });
});

describe('liveTotals', () => {
  const v = { revenue: 1000, orders: 10, today: { date: '2026-11-27', revenue: 100, orders: 2 } };
  it('swaps today for the fresher pulse', () => {
    const pulse = { live: true, today: '2026-11-27', todayByGroup: { web: { revenue: 150, orders: 3 }, locales: { revenue: 50, orders: 1 } } };
    expect(liveTotals(v, pulse)).toEqual({ revenue: 1100, orders: 12, todayRevenue: 200, todayOrders: 4 });
  });
  it('keeps the report as is when the pulse is about another day or missing', () => {
    expect(liveTotals(v, { live: true, today: '2026-11-28', todayByGroup: {} }).revenue).toBe(1000);
    expect(liveTotals(v, null).revenue).toBe(1000);
  });
  it('a day not played yet counts as zero today', () => {
    const notPlayed = { revenue: 0, orders: 0, today: { date: '2026-11-25', revenue: null, orders: null } };
    const pulse = { live: true, today: '2026-11-25', todayByGroup: { web: { revenue: 70, orders: 1 } } };
    expect(liveTotals(notPlayed, pulse)).toEqual({ revenue: 70, orders: 1, todayRevenue: 70, todayOrders: 1 });
  });
});
