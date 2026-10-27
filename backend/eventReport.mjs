import { querySalesByRange, getProductsBySku, getInflationIndexByMonth } from './firestore.mjs';
import { computeTopProducts } from './aggregate.mjs';
import {
  EVENTS, EVENT_GROUPS, TARGET_REAL_GROWTH, addDays, argDay, dailyByChannel, buildEventDays,
  summarizePastEvent, baselineRange, projectInflationIndex, inflationFactor, channelsWithoutHistory,
} from './events.mjs';

const ALL_EVENT_CHANNELS = Object.values(EVENT_GROUPS).flat();
// "A normal day" for last year's lift: the two weeks right before the event.
const RECAP_BASELINE_DAYS = 14;

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
  const [indexByMonth, productsBySku, prevSales, currentSales, baselineSales, recapBaselineSales] = await Promise.all([
    getInflationIndexByMonth(),
    getProductsBySku(),
    prevSalesPromise,
    querySalesByRange(ALL_EVENT_CHANNELS, current.start, current.end),
    baselinePromise,
    querySalesByRange(ALL_EVENT_CHANNELS, recapBaselineStart, recapBaselineEnd),
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
