import {
  querySalesByRange, getProductsBySku, getInflationIndexByMonth, queryMetaAdsDailyByRange, queryGoogleAdsDailyByRange,
  getSyncMetadata,
} from './firestore.mjs';
import { computeTopProducts } from './aggregate.mjs';
import {
  EVENTS, EVENT_GROUPS, TARGET_REAL_GROWTH, addDays, argDay, dailyByChannel, buildEventDays,
  summarizePastEvent, baselineRange, projectInflationIndex, inflationFactor, channelsWithoutHistory,
  adsByDate, attributionShares, buildInvestmentPlan, AD_PLATFORMS,
  hourlyShareCurve, expectedShare, dayStatusSoFar, projectClose, recentSales, argHour,
} from './events.mjs';
import { summarizeCategories } from './eventCategories.mjs';

const ALL_EVENT_CHANNELS = Object.values(EVENT_GROUPS).flat();
// "A normal day" for last year's lift: the two weeks right before the event.
const RECAP_BASELINE_DAYS = 14;
// How much of real web revenue each ad platform claims, measured over the
// last 4 normal weeks (current attribution settings), to turn the web
// revenue target into a per-platform ROAS target.
const SHARES_DAYS = 28;

async function queryAds(start, end) {
  const [meta, google] = await Promise.all([queryMetaAdsDailyByRange(start, end), queryGoogleAdsDailyByRange(start, end)]);
  return adsByDate(meta, google);
}

// Share of Google's spend and GA4 revenue that is brand search, over a range.
async function googleBrandShare(start, end) {
  const docs = await queryGoogleAdsDailyByRange(start, end);
  const t = docs.reduce((a, d) => ({
    spend: a.spend + (d.spend || 0), spendBrand: a.spendBrand + (d.spendBrand || 0),
    revenue: a.revenue + (d.purchaseValue || 0), revenueBrand: a.revenueBrand + (d.ga4RevenueBrand || 0),
  }), { spend: 0, spendBrand: 0, revenue: 0, revenueBrand: 0 });
  return {
    spendPct: t.spend ? t.spendBrand / t.spend : null,
    revenuePct: t.revenue ? t.revenueBrand / t.revenue : null,
    roasNonBrand: t.spend - t.spendBrand ? (t.revenue - t.revenueBrand) / (t.spend - t.spendBrand) : null,
  };
}

function emptyAds() {
  return { meta: { spend: 0, value: 0 }, google: { spend: 0, value: 0 } };
}

// Tiendanube coupons come through as a negative-priced "Descuento
// Tiendanube" line, which would otherwise top the units ranking during a
// promo event.
function withoutDiscountLines(docs) {
  return docs.map(s => ({ ...s, items: s.items.filter(i => i.unitPrice >= 0) }));
}

function todayART() {
  return argDay(new Date().toISOString());
}

function inflationAssumptions(indexByMonth, current, previous) {
  const months = [...new Set([current.start.slice(0, 7), current.end.slice(0, 7)])];
  // Projecting the month right after the last published one exposes the
  // rate used for every not-yet-published month.
  const lastPublished = [...indexByMonth.keys()].sort().at(-1);
  const [y, m] = (lastPublished || '1970-01').split('-').map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const projection = projectInflationIndex(indexByMonth, nextMonth);
  return {
    lastPublishedMonth: projection.lastPublishedMonth || null,
    projectedMonthlyRatePct: projection.monthlyRate != null ? Math.round(projection.monthlyRate * 10000) / 100 : null,
    yearOverYear: months.map((month) => {
      const refMonth = `${previous.year}${month.slice(4)}`;
      const { factor, projected } = inflationFactor(indexByMonth, refMonth, month);
      return { month, refMonth, pct: Math.round((factor - 1) * 1000) / 10, projected };
    }),
  };
}

// Everything that doesn't depend on this year's sales/ads so far. Cached for
// a long time: last year's windows and the weeks before the event don't move.
async function loadStaticInputs(eventId) {
  const event = EVENTS[eventId];
  if (!event) throw new Error(`Unknown event: ${eventId}`);
  const { current, previous } = event;

  // Last year's aligned days can fall outside last year's promo window
  // (we run longer this year), so query a range that covers both.
  const shift = Math.round((new Date(previous.officialStart) - new Date(current.officialStart)) / 86400000);
  const prevQueryStart = [previous.start, addDays(current.start, shift)].sort()[0];
  const prevQueryEnd = [previous.end, addDays(current.end, shift)].sort()[1];
  const today = todayART();
  const baseline = baselineRange(current, today);
  const recapBaselineStart = addDays(previous.start, -RECAP_BASELINE_DAYS);
  const recapBaselineEnd = addDays(previous.start, -1);

  // The 8-week run-rate query is by far the heaviest, and only channels
  // with no sales last year need it — so it waits for last year's sales.
  const prevSalesPromise = querySalesByRange(ALL_EVENT_CHANNELS, prevQueryStart, prevQueryEnd);
  const baselinePromise = prevSalesPromise.then((sales) => {
    const missing = channelsWithoutHistory(dailyByChannel(sales), previous);
    return missing.length ? querySalesByRange(missing, baseline.start, baseline.end) : [];
  });
  const sharesEnd = [addDays(current.start, -1), addDays(today, -1)].sort()[0];
  const sharesStart = addDays(sharesEnd, -SHARES_DAYS + 1);
  const [
    indexByMonth, productsBySku, prevSales, baselineSales, recapBaselineSales,
    prevAds, sharesAds, sharesWebSales, brandPrev, brandRecent,
  ] = await Promise.all([
    getInflationIndexByMonth(),
    getProductsBySku(),
    prevSalesPromise,
    baselinePromise,
    querySalesByRange(ALL_EVENT_CHANNELS, recapBaselineStart, recapBaselineEnd),
    queryAds([recapBaselineStart, prevQueryStart].sort()[0], prevQueryEnd),
    queryAds(sharesStart, sharesEnd),
    querySalesByRange(EVENT_GROUPS.web, sharesStart, sharesEnd),
    googleBrandShare(previous.start, previous.end),
    googleBrandShare(sharesStart, sharesEnd),
  ]);
  return {
    indexByMonth, productsBySku, prevSales, baselineSales, recapBaselineSales,
    prevAds, sharesAds, sharesWebSales, brandPrev, brandRecent,
    sharesStart, sharesEnd, recapBaselineStart, recapBaselineEnd,
  };
}

const STATIC_TTL_MS = 60 * 60 * 1000;
const staticCache = new Map();

function getStaticInputs(eventId) {
  const hit = staticCache.get(eventId);
  if (hit && Date.now() - hit.at < STATIC_TTL_MS) return hit.promise;
  const promise = loadStaticInputs(eventId);
  staticCache.set(eventId, { at: Date.now(), promise });
  promise.catch(() => staticCache.delete(eventId));
  return promise;
}

// Top-selling product (by units) among completed sales of one ART day.
export function topProductOfDay(salesDocs, day) {
  const units = new Map();
  for (const s of salesDocs) {
    if (s.status !== 'completed' || argDay(s.date) !== day) continue;
    for (const i of s.items || []) {
      if (!(i.unitPrice >= 0)) continue;
      units.set(i.name, (units.get(i.name) || 0) + i.qty);
    }
  }
  let best = null;
  for (const [name, u] of units) if (!best || u > best.units) best = { name, units: u };
  return best;
}

// ART hour with the most completed revenue on one day (null if no sales).
export function peakHourOfDay(salesDocs, day) {
  const byHour = new Map();
  for (const s of salesDocs) {
    if (s.status !== 'completed' || argDay(s.date) !== day) continue;
    const h = argHour(s.date);
    byHour.set(h, (byHour.get(h) || 0) + s.total);
  }
  let best = null;
  for (const [hour, revenue] of byHour) if (!best || revenue > best.revenue) best = { hour, revenue };
  return best;
}

// Share of the day already elapsed, per group: the typical hourly curve when
// today is an event day, 1 once the event is over, 0 before it starts.
function todayShareFor(curve, current, today, nowIso) {
  if (today > current.end) return 1;
  if (today < current.start) return 0;
  return expectedShare(curve, nowIso);
}

// Live block: pace of today against the typical hourly curve, projected
// close, recent orders and per-category progress.
export function buildLive({ event, result, currentSales, prevSales, productsBySku, today, ecommerceMeta, nowIso = new Date().toISOString() }) {
  const { current, previous } = event;
  const inPrevWindow = (s) => {
    const d = argDay(s.date);
    return d >= previous.start && d <= previous.end;
  };
  const curves = {};
  const todayShare = {};
  for (const [group, channels] of Object.entries(EVENT_GROUPS)) {
    curves[group] = hourlyShareCurve(prevSales.filter(s => channels.includes(s.channel) && inPrevWindow(s)));
    todayShare[group] = todayShareFor(curves[group], current, today, nowIso);
  }

  const todayDay = result.days.find(d => d.date === today && d.played);
  const todayStatus = { web: null, locales: null, total: null };
  if (todayDay) {
    for (const group of Object.keys(EVENT_GROUPS)) todayStatus[group] = dayStatusSoFar(todayDay[group], todayShare[group]);
    const sum = (k) => todayDay.web[k] + todayDay.locales[k];
    todayStatus.total = dayStatusSoFar({ revenue: sum('revenue'), floor: sum('floor'), target: sum('target') }, todayShare.web);
  }

  const projection = {};
  for (const group of Object.keys(EVENT_GROUPS)) projection[group] = projectClose(result.days, group, todayShare[group]);
  projection.total = projection.web != null && projection.locales != null ? projection.web + projection.locales : null;

  const refDates = new Set(result.days.filter(d => d.played).map(d => d.refDate));
  const factorByRefDate = new Map(result.days.map(d => [d.refDate, d.inflationFactor]));
  const categories = summarizeCategories({
    prevDocs: prevSales.filter(inPrevWindow),
    prevToDateDocs: prevSales.filter(s => refDates.has(argDay(s.date))),
    currentDocs: currentSales,
    productsBySku,
    factorByRefDate,
  });

  return {
    updatedAt: ecommerceMeta?.lastSyncedAt ?? null,
    now: nowIso,
    todayShare,
    todayStatus,
    projection,
    feed: recentSales(currentSales, 12),
    topProductToday: topProductOfDay(currentSales, today),
    peakHourYesterday: peakHourOfDay(currentSales, addDays(today, -1)),
    categories,
    curves,
  };
}

export async function buildEventReport(eventId) {
  const event = EVENTS[eventId];
  if (!event) throw new Error(`Unknown event: ${eventId}`);
  const { current, previous } = event;
  const today = todayART();

  const [st, currentSales, currentAds, ecommerceMeta] = await Promise.all([
    getStaticInputs(eventId),
    querySalesByRange(ALL_EVENT_CHANNELS, current.start, current.end),
    queryAds(current.start, current.end),
    getSyncMetadata('ecommerce'),
  ]);
  const {
    indexByMonth, productsBySku, prevSales, baselineSales, recapBaselineSales,
    prevAds, sharesAds, sharesWebSales, brandPrev, brandRecent,
    sharesStart, sharesEnd, recapBaselineStart, recapBaselineEnd,
  } = st;

  const result = buildEventDays({
    current,
    previous,
    prevDaily: dailyByChannel(prevSales),
    currentDaily: dailyByChannel(currentSales),
    baselineDaily: dailyByChannel(baselineSales),
    indexByMonth,
    today,
  });

  for (const day of result.days) {
    day.ads = {
      prev: prevAds.get(day.refDate) || emptyAds(),
      actual: day.played ? (currentAds.get(day.date) || emptyAds()) : null,
    };
  }
  const shares = attributionShares(sharesAds, dailyByChannel(sharesWebSales).ecommerce, sharesStart, sharesEnd);
  const recapBaselineDates = [];
  for (let d = recapBaselineStart; d <= recapBaselineEnd; d = addDays(d, 1)) recapBaselineDates.push(d);
  const investment = {
    ...buildInvestmentPlan({ days: result.days, current, prevAds, prevBaselineDates: recapBaselineDates, shares }),
    sharesRange: { start: sharesStart, end: sharesEnd },
    prevBaselineRange: { start: recapBaselineStart, end: recapBaselineEnd },
    googleBrand: { previous: brandPrev, recent: brandRecent },
  };
  const inWindow = (s) => {
    const d = argDay(s.date);
    return d >= previous.start && d <= previous.end;
  };
  // Last year's ads in today's pesos, and the planned spend of each day.
  for (const [i, day] of result.days.entries()) {
    day.ads.prevAdj = Object.fromEntries(AD_PLATFORMS.map(p => [p, {
      spend: day.ads.prev[p].spend * day.inflationFactor,
      value: day.ads.prev[p].value * day.inflationFactor,
    }]));
    day.ads.plan = Object.fromEntries(AD_PLATFORMS.map(p => [p, investment.days[i]?.[p] ?? null]));
  }
  // Last year's full promo window, day by day (not the aligned days).
  const prevWindowAds = [];
  for (let d = previous.start; d <= previous.end; d = addDays(d, 1)) {
    const a = prevAds.get(d) || emptyAds();
    prevWindowAds.push({ date: d, ...Object.fromEntries(AD_PLATFORMS.map(p => [p, a[p]])) });
  }

  const recap = {};
  for (const [group, channels] of Object.entries(EVENT_GROUPS)) {
    const docs = prevSales.filter(s => channels.includes(s.channel) && inWindow(s));
    const baseDocs = recapBaselineSales.filter(s => channels.includes(s.channel));
    recap[group] = {
      ...summarizePastEvent(docs, baseDocs, previous),
      byChannel: channels.map((channel) => {
        const own = docs.filter(s => s.channel === channel && s.status === 'completed');
        return { channel, revenue: own.reduce((sum, s) => sum + s.total, 0), orders: own.length };
      }),
      topProductsByRevenue: computeTopProducts(withoutDiscountLines(docs), productsBySku, { by: 'revenue', limit: 10 }),
      topProductsByUnits: computeTopProducts(withoutDiscountLines(docs), productsBySku, { by: 'units', limit: 10 }),
    };
  }

  const { curves, ...live } = buildLive({ event, result, currentSales, prevSales, productsBySku, today, ecommerceMeta });

  return {
    event: eventId,
    label: event.label,
    current,
    previous,
    today,
    assumptions: {
      realGrowth: TARGET_REAL_GROWTH,
      inflation: inflationAssumptions(indexByMonth, current, previous),
      channelsWithoutHistory: result.channelsWithoutHistory,
      baselineRange: result.baselineRange,
    },
    days: result.days,
    totals: result.totals,
    previousRecap: recap,
    investment,
    previousAds: prevWindowAds,
    live,
    curves,
  };
}

// Cheap to rebuild from the static bundle: only this year's sales/ads and the
// sync metadata are fetched, so a short TTL keeps the live tab fresh.
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

export async function getEventReport(eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildEventReport(eventId);
  cache.set(eventId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(eventId));
  return promise;
}
