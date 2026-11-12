// GET /api/v2/web: Odoo web sales, GA4 behaviour and Clarity (from the daily
// snapshots) for the chosen period. GA4 and Clarity are optional: if one fails
// the rest still renders.
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getInflationIndexByMonth, queryDailySnapshots, CLARITY_DAILY_COL } from './firestore.mjs';
import { argDay, inflationFactor } from './events.mjs';
import { prevYearToDate } from './productTab.mjs';
import { webSalesSummary } from './webSales.mjs';
import { clarityForPeriod } from './clarityPeriod.mjs';
import { getWebBehavior } from './eventBehavior.mjs';
import { isGa4Configured } from './ga4.mjs';

const month = (r) => r.start.slice(0, 7);

// A running period is compared with the same elapsed days of the previous
// period and of last year (a half week against a whole one always looks
// down). Once the period is closed both are the full windows, the same ones
// the Resumen asks GA4 for, so both tabs share its cache.
const span = ({ start, end }) => ({ start, end });
export function webPlan(ranges, today) {
  const prevRange = prevYearToDate(ranges, today);
  const prevPeriodRange = prevYearToDate({ current: ranges.current, prevYear: ranges.prevPeriod }, today);
  return {
    prevRange,
    prevPeriodRange,
    gaRanges: { cur: ranges.current, prev: span(prevPeriodRange), yoy: span(prevRange) },
  };
}

export async function buildWeb({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const today = argDay(now.toISOString());
  const { prevRange, prevPeriodRange, gaRanges } = webPlan(ranges, today);

  const ga4 = isGa4Configured();
  let behaviorError = ga4 ? null : 'GA4 no configurado';
  const [curDocs, prevDocs, prevYearDocs, indexByMonth, behavior, snapshots] = await Promise.all([
    querySalesByRange(['ecommerce'], current.start, current.end),
    querySalesByRange(['ecommerce'], prevPeriodRange.start, prevPeriodRange.end),
    querySalesByRange(['ecommerce'], prevRange.start, prevRange.end),
    getInflationIndexByMonth(),
    ga4 ? getWebBehavior(gaRanges).catch(err => { console.error('[web] GA4:', err.message); behaviorError = 'GA4 no respondió'; return null; }) : null,
    queryDailySnapshots(CLARITY_DAILY_COL, current.start, current.end).catch(err => { console.error('[web] clarity:', err.message); return null; }),
  ]);

  const currentIndex = indexByMonth.get(month(current));
  const prevYearIndex = indexByMonth.get(month(prevRange));
  const yf = inflationFactor(indexByMonth, month(prevRange), month(current));

  return {
    range: current,
    prevRange,
    prevPeriodRange,
    prevYear: Number(prevRange.start.slice(0, 4)),
    sales: webSalesSummary({
      curDocs, prevDocs, prevYearDocs, range: current,
      inflation: { currentIndex, prevYearIndex },
      prevYearFactor: yf.missing ? null : yf.factor,
    }),
    behavior,
    behaviorError: behavior ? null : behaviorError,
    clarity: clarityForPeriod(snapshots, current, { today }),
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getWeb(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildWeb(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
