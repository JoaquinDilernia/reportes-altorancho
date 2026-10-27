import {
  querySalesByRange, getProductsBySku, getInflationIndexByMonth, queryMetaAdsDailyByRange, queryGoogleAdsDailyByRange,
} from './firestore.mjs';
import { computeTopProducts } from './aggregate.mjs';
import {
  EVENTS, EVENT_GROUPS, TARGET_REAL_GROWTH, addDays, argDay, dailyByChannel, buildEventDays,
  summarizePastEvent, baselineRange, projectInflationIndex, inflationFactor, channelsWithoutHistory,
  adsByDate, attributionShares, buildInvestmentPlan, AD_PLATFORMS,
} from './events.mjs';

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

export async function buildEventReport(eventId) {
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
    indexByMonth, productsBySku, prevSales, currentSales, baselineSales, recapBaselineSales,
    prevAds, currentAds, sharesAds, sharesWebSales,
  ] = await Promise.all([
    getInflationIndexByMonth(),
    getProductsBySku(),
    prevSalesPromise,
    querySalesByRange(ALL_EVENT_CHANNELS, current.start, current.end),
    baselinePromise,
    querySalesByRange(ALL_EVENT_CHANNELS, recapBaselineStart, recapBaselineEnd),
    queryAds([recapBaselineStart, prevQueryStart].sort()[0], prevQueryEnd),
    queryAds(current.start, current.end),
    queryAds(sharesStart, sharesEnd),
    querySalesByRange(EVENT_GROUPS.web, sharesStart, sharesEnd),
  ]);

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
  };
  // Last year's full promo window, day by day (not the aligned days).
  const prevWindowAds = [];
  for (let d = previous.start; d <= previous.end; d = addDays(d, 1)) {
    const a = prevAds.get(d) || emptyAds();
    prevWindowAds.push({ date: d, ...Object.fromEntries(AD_PLATFORMS.map(p => [p, a[p]])) });
  }

  const inWindow = (s) => {
    const d = argDay(s.date);
    return d >= previous.start && d <= previous.end;
  };
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
  };
}

// Sales only sync every few hours and this report reads ~a year's worth of
// windows, so a short in-memory cache keeps the tab snappy when the meeting
// flips between Cyber/Black and Web/Locales.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export async function getEventReport(eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildEventReport(eventId);
  cache.set(eventId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(eventId));
  return promise;
}
