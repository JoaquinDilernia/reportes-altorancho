// Web behaviour during Cyber / Black, from GA4: funnel, traffic sources,
// devices, categories viewed vs bought, products with interest but no sales,
// on-site searches, landing pages and hours. This year's event to date vs.
// last year's event over the same number of days.
//
// GA4 caveats, verified live on Cyber 2026:
// - GA4's own sessionConversionRate is broken in this property (73% in 2026),
//   so conversion is always purchases / sessions here.
// - begin_checkout / add_payment_info counted fewer in 2026 than 2025 while
//   purchases went up — checkout tracking changed, so those steps are left out.
// - GA4's itemCategory is Tiendanube's first category ("Alto Cyber." for most
//   products), so items are mapped to the Odoo-based event categories instead.
import { EVENTS, addDays, argDay } from './events.mjs';
import { EVENT_CATEGORIES, eventCategoryOf } from './eventCategories.mjs';
import { getProductsBySku } from './firestore.mjs';
import { runGa4Report, isGa4Configured } from './ga4.mjs';

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const rate = (num, den) => (den ? num / den : null);
export const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

// This year's event up to today (or its end), and last year's over the same
// number of days (capped at its own end).
export function behaviorRanges(event, today) {
  const { current, previous } = event;
  const curEnd = today < current.end ? today : current.end;
  const elapsed = daysBetween(current.start, curEnd) + 1;
  const prevEnd = addDays(previous.start, elapsed - 1) < previous.end ? addDays(previous.start, elapsed - 1) : previous.end;
  return {
    cur: { start: current.start, end: curEnd, days: elapsed },
    prev: { start: previous.start, end: prevEnd, days: daysBetween(previous.start, prevEnd) + 1 },
  };
}

// Product docs indexed by normalized Tiendanube name (GA4's itemName), with
// the web stock summed across the name's variants.
export function productsByName(productsBySku) {
  const map = new Map();
  for (const p of productsBySku.values()) {
    if (!p?.name) continue;
    const key = normName(p.name);
    const e = map.get(key);
    if (!e) map.set(key, { product: p, webStock: p.currentStock ?? null });
    else {
      if (!e.product.odooCategPath && p.odooCategPath) e.product = p;
      if (p.currentStock != null) e.webStock = (e.webStock ?? 0) + p.currentStock;
    }
  }
  return map;
}

const byRange = (rows, name) => rows.filter(r => !r.dateRange || r.dateRange === name);

function totalsOf(rows) {
  const r = rows[0] || {};
  return {
    sessions: r.sessions || 0,
    users: r.totalUsers || 0,
    newUsers: r.newUsers || 0,
    engagementRate: r.engagementRate ?? null,
    avgSessionSec: r.averageSessionDuration ?? null,
    pagesPerSession: r.screenPageViewsPerSession ?? null,
    purchases: r.ecommercePurchases || 0,
    revenue: r.purchaseRevenue || 0,
    conversion: rate(r.ecommercePurchases || 0, r.sessions || 0),
    avgTicket: rate(r.purchaseRevenue || 0, r.ecommercePurchases || 0),
  };
}

const FUNNEL_STEPS = [
  { id: 'session_start', label: 'Entraron al sitio' },
  { id: 'view_item', label: 'Vieron un producto' },
  { id: 'add_to_cart', label: 'Agregaron al carrito' },
  { id: 'purchase', label: 'Compraron' },
];

function funnelOf(rows) {
  const users = new Map(rows.map(r => [r.eventName, r.totalUsers || 0]));
  return FUNNEL_STEPS.map(s => ({ ...s, users: users.get(s.id) || 0 }));
}

// Rows grouped by one dimension, this year vs last year side by side.
function compareBy(rows, dim, { sortBy = 'sessions' } = {}) {
  const map = new Map();
  for (const r of rows) {
    const key = r[dim] || '(sin dato)';
    if (!map.has(key)) map.set(key, { key, cur: null, prev: null });
    map.get(key)[r.dateRange === 'prev' ? 'prev' : 'cur'] = {
      sessions: r.sessions || 0,
      purchases: r.ecommercePurchases || 0,
      revenue: r.purchaseRevenue || 0,
      conversion: rate(r.ecommercePurchases || 0, r.sessions || 0),
    };
  }
  return [...map.values()].sort((a, b) => (b.cur?.[sortBy] || 0) - (a.cur?.[sortBy] || 0));
}

function itemsSummary(itemRows, byName) {
  const blank = () => ({ views: 0, carts: 0, purchases: 0, revenue: 0, prevViews: 0, prevCarts: 0, prevPurchases: 0 });
  const cats = new Map(EVENT_CATEGORIES.map(c => [c.id, { ...c, ...blank() }]));
  const items = new Map();
  let matched = 0;
  let views = 0;
  for (const r of itemRows) {
    const hit = byName.get(normName(r.itemName));
    const catId = eventCategoryOf(hit?.product, r.itemName);
    const c = cats.get(catId);
    const prev = r.dateRange === 'prev';
    if (prev) {
      c.prevViews += r.itemsViewed; c.prevCarts += r.itemsAddedToCart; c.prevPurchases += r.itemsPurchased;
      continue;
    }
    views += r.itemsViewed;
    if (hit) matched += r.itemsViewed;
    c.views += r.itemsViewed; c.carts += r.itemsAddedToCart; c.purchases += r.itemsPurchased; c.revenue += r.itemRevenue;
    const key = normName(r.itemName);
    const it = items.get(key) ?? {
      name: r.itemName, category: c.label, webStock: hit?.webStock ?? null, views: 0, carts: 0, purchases: 0, revenue: 0,
    };
    it.views += r.itemsViewed; it.carts += r.itemsAddedToCart; it.purchases += r.itemsPurchased; it.revenue += r.itemRevenue;
    items.set(key, it);
  }
  const withRates = (x) => ({ ...x, cartRate: rate(x.carts, x.views), buyRate: rate(x.purchases, x.views) });
  const categories = [...cats.values()].filter(c => c.views || c.prevViews).map(withRates).sort((a, b) => b.views - a.views);
  const list = [...items.values()].map(withRates);
  const MIN_VIEWS = 2000;
  return {
    categories,
    topViewed: [...list].sort((a, b) => b.views - a.views).slice(0, 15),
    // Lots of people looked, few bought: the cheapest wins (price, photos,
    // stock, the ad sending people there).
    lowConversion: list.filter(i => i.views >= MIN_VIEWS).sort((a, b) => a.buyRate - b.buyRate).slice(0, 10),
    bestConversion: list.filter(i => i.views >= MIN_VIEWS / 2).sort((a, b) => b.buyRate - a.buyRate).slice(0, 10),
    matchedViewShare: rate(matched, views),
  };
}

// Searches typed on the site; GA4 keeps junk like "baby fungi/?utm_source=…".
export function cleanSearches(rows, limit = 20) {
  const map = new Map();
  for (const r of rows) {
    const term = String(r.searchTerm || '').split(/[/?#]/)[0].trim().toLowerCase();
    if (!term || term === '(not set)') continue;
    map.set(term, (map.get(term) || 0) + (r.eventCount || 0));
  }
  return [...map.entries()].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

// Landing pages; /productos/<sku> is shown with the product's name.
function landingsOf(rows, productsBySku, byName, limit = 15) {
  return rows.slice(0, limit).map(r => {
    const m = /^\/productos\/([^/?#]+)/.exec(r.landingPage || '');
    let label = r.landingPage === '/' ? 'Inicio (/)' : r.landingPage;
    if (m) {
      const p = productsBySku.get(m[1]) || productsBySku.get(m[1].toUpperCase());
      label = p?.name || m[1].replace(/-/g, ' ');
    }
    return { page: r.landingPage, label, sessions: r.sessions, purchases: r.ecommercePurchases, conversion: rate(r.ecommercePurchases, r.sessions) };
  });
}

function hourlyOf(rows) {
  const out = Array.from({ length: 24 }, (_, h) => ({ hour: h, sessions: 0, purchases: 0 }));
  for (const r of rows) {
    const h = Number(r.hour);
    if (out[h]) { out[h].sessions += r.sessions; out[h].purchases += r.ecommercePurchases; }
  }
  return out.map(h => ({ ...h, conversion: rate(h.purchases, h.sessions) }));
}

function dailyOf(rows) {
  return rows
    .map(r => ({
      date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
      sessions: r.sessions, carts: r.addToCarts, purchases: r.ecommercePurchases,
      conversion: rate(r.ecommercePurchases, r.sessions),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function shapeBehavior({ ranges, raw, productsBySku }) {
  const byName = productsByName(productsBySku);
  const cur = totalsOf(byRange(raw.totals, 'cur'));
  const prev = totalsOf(byRange(raw.totals, 'prev'));
  return {
    ranges,
    totals: { cur, prev },
    funnel: { cur: funnelOf(byRange(raw.funnel, 'cur')), prev: funnelOf(byRange(raw.funnel, 'prev')) },
    channels: compareBy(raw.channels, 'sessionDefaultChannelGroup'),
    devices: compareBy(raw.devices, 'deviceCategory'),
    visitors: compareBy(raw.visitors, 'newVsReturning').filter(v => v.key === 'new' || v.key === 'returning'),
    items: itemsSummary(raw.items, byName),
    searches: cleanSearches(raw.searches),
    landings: landingsOf(raw.landings, productsBySku, byName),
    regions: raw.regions.map(r => ({ region: r.region, sessions: r.sessions, purchases: r.ecommercePurchases, conversion: rate(r.ecommercePurchases, r.sessions) })),
    hourly: hourlyOf(raw.hourly),
    daily: dailyOf(raw.daily),
  };
}

async function fetchRaw(ranges) {
  const both = [
    { startDate: ranges.cur.start, endDate: ranges.cur.end, name: 'cur' },
    { startDate: ranges.prev.start, endDate: ranges.prev.end, name: 'prev' },
  ];
  const cur = [both[0]];
  const salesMetrics = [{ name: 'sessions' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }];
  const desc = (metricName) => [{ metric: { metricName }, desc: true }];
  const queries = {
    totals: { dateRanges: both, metrics: ['sessions', 'totalUsers', 'newUsers', 'engagementRate', 'averageSessionDuration', 'screenPageViewsPerSession', 'ecommercePurchases', 'purchaseRevenue'].map(name => ({ name })) },
    funnel: {
      dateRanges: both, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'totalUsers' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_STEPS.map(s => s.id) } } },
    },
    channels: { dateRanges: both, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: salesMetrics, limit: 50 },
    devices: { dateRanges: both, dimensions: [{ name: 'deviceCategory' }], metrics: salesMetrics },
    visitors: { dateRanges: both, dimensions: [{ name: 'newVsReturning' }], metrics: salesMetrics },
    items: {
      dateRanges: both, dimensions: [{ name: 'itemName' }],
      metrics: [{ name: 'itemsViewed' }, { name: 'itemsAddedToCart' }, { name: 'itemsPurchased' }, { name: 'itemRevenue' }],
      orderBys: desc('itemsViewed'), limit: 5000,
    },
    searches: { dateRanges: cur, dimensions: [{ name: 'searchTerm' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'view_search_results' } } }, orderBys: desc('eventCount'), limit: 200 },
    landings: { dateRanges: cur, dimensions: [{ name: 'landingPage' }], metrics: salesMetrics, orderBys: desc('sessions'), limit: 15 },
    regions: { dateRanges: cur, dimensions: [{ name: 'region' }], metrics: salesMetrics, orderBys: desc('sessions'), limit: 10 },
    hourly: { dateRanges: cur, dimensions: [{ name: 'hour' }], metrics: salesMetrics, limit: 24 },
    daily: { dateRanges: cur, dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'addToCarts' }, { name: 'ecommercePurchases' }], limit: 60 },
  };
  // GA4 allows 10 concurrent requests per property; stay under it.
  const entries = Object.entries(queries);
  const raw = {};
  for (let i = 0; i < entries.length; i += 5) {
    const chunk = entries.slice(i, i + 5);
    const results = await Promise.all(chunk.map(([, body]) => runGa4Report(body)));
    chunk.forEach(([k], j) => { raw[k] = results[j]; });
  }
  return raw;
}

export async function buildBehaviorReport(eventId, { today = argDay(new Date().toISOString()) } = {}) {
  const event = EVENTS[eventId];
  if (!isGa4Configured()) return { event: eventId, available: false, reason: 'GA4 no configurado' };
  if (today < event.current.start) return { event: eventId, available: false, reason: 'El evento todavía no empezó' };
  const ranges = behaviorRanges(event, today);
  const [raw, productsBySku] = await Promise.all([fetchRaw(ranges), getProductsBySku()]);
  return {
    event: eventId, available: true, label: event.label,
    year: event.current.year, prevYear: event.previous.year,
    generatedAt: new Date().toISOString(),
    ...shapeBehavior({ ranges, raw, productsBySku }),
  };
}

// GA4 lags a few hours and each build is ~10 report calls: 30 min is plenty.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

export function getBehaviorReport(eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildBehaviorReport(eventId);
  cache.set(eventId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(eventId));
  return promise;
}
