// Pure logic for the TV screen ("modo tele") of Cyber/Black: which sales are
// new since the last poll, how big a celebration each one gets, and the live
// counter (the report's total with today swapped for the fresher pulse).

// Tiers by the amount shown on screen (web without VAT, stores with VAT, as
// everywhere else in the report). 0 = small sale: a short blip, no overlay.
export const TIERS = [
  { tier: 4, min: 2_000_000, title: '¡¡VENTA ÉPICA!!', ms: 9000 },
  { tier: 3, min: 1_500_000, title: '¡MEGA VENTA!', ms: 6500 },
  { tier: 2, min: 1_000_000, title: '¡SÚPER VENTA!', ms: 5000 },
  { tier: 1, min: 500_000, title: '¡VENTAZA!', ms: 4000 },
];

export function tierOf(amount) {
  return TIERS.find(t => (amount || 0) >= t.min)?.tier ?? 0;
}

export function tierInfo(tier) {
  return TIERS.find(t => t.tier === tier) ?? null;
}

// Sales on the feed that weren't there before, oldest first (the order they
// happened in). The first poll only learns what's already there: opening
// the screen must not replay the last 20 sales.
export function newSales(seen, feed) {
  if (!seen) return [];
  return (feed || []).filter(s => s.id && !seen.has(s.id)).sort((a, b) => new Date(a.date) - new Date(b.date));
}

export function feedIds(feed, seen = new Set()) {
  const out = new Set(seen);
  for (const s of feed || []) if (s.id) out.add(s.id);
  return out;
}

const GROUPS = { total: ['web', 'locales'], web: ['web'], locales: ['locales'] };

// The report's event total and today, with today's part replaced by the
// pulse's (polled every ~20 s instead of every 2 min). Only when both talk
// about the same day; otherwise the report's numbers as they are.
export function liveTotals(v, pulse, view = 'total') {
  const base = { revenue: v?.revenue ?? 0, orders: v?.orders ?? 0, todayRevenue: v?.today?.revenue ?? 0, todayOrders: v?.today?.orders ?? 0 };
  if (!v || !pulse?.live || pulse.today !== v.today?.date) return base;
  const groups = GROUPS[view] ?? GROUPS.total;
  const sum = (k) => groups.reduce((s, g) => s + (pulse.todayByGroup?.[g]?.[k] || 0), 0);
  const todayRevenue = sum('revenue');
  const todayOrders = sum('orders');
  return {
    revenue: base.revenue - base.todayRevenue + todayRevenue,
    orders: base.orders - base.todayOrders + todayOrders,
    todayRevenue,
    todayOrders,
  };
}
