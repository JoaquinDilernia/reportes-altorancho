// GET /api/v2/locales: the three stores side by side, sales per day and per
// hour, and each store's detail (top sellers, categories, origin, payment
// methods, stock). All three details come at once so switching is instant.
// A running period is compared with the same elapsed days (see webPlan).
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getProductsBySku, getInflationIndexByMonth } from './firestore.mjs';
import { argDay, inflationFactor } from './events.mjs';
import { getOriginBySku } from './productOrigin.mjs';
import { dailyStacked } from './resumen.mjs';
import { webPlan } from './webReport.mjs';
import { LOCALES, localesSideBySide, localesByHour, localDetail } from './localesTab.mjs';

const CHANNELS = LOCALES.map(l => l.channel);
const month = (r) => r.start.slice(0, 7);

export async function buildLocales({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const today = argDay(now.toISOString());
  const { prevRange, prevPeriodRange } = webPlan(ranges, today);

  const [curDocs, prevDocs, yearDocs, productsBySku, indexByMonth, originBySku] = await Promise.all([
    querySalesByRange(CHANNELS, current.start, current.end),
    querySalesByRange(CHANNELS, prevPeriodRange.start, prevPeriodRange.end),
    querySalesByRange(CHANNELS, prevRange.start, prevRange.end),
    getProductsBySku(),
    getInflationIndexByMonth(),
    getOriginBySku().catch(err => { console.error('[locales] origin:', err.message); return null; }),
  ]);

  const currentIndex = indexByMonth.get(month(current));
  const prevYearIndex = indexByMonth.get(month(prevRange));
  const yf = inflationFactor(indexByMonth, month(prevRange), month(current));
  const factorByRefDate = { get: () => (yf.missing ? 1 : yf.factor) };
  const of = (docs, channel) => docs.filter(d => d.channel === channel);

  return {
    range: current,
    prevRange,
    prevPeriodRange,
    prevYear: Number(prevRange.start.slice(0, 4)),
    inflationAdjusted: !yf.missing,
    compare: localesSideBySide({ curDocs, prevDocs, yearDocs, inflation: { currentIndex, prevYearIndex } }),
    daily: dailyStacked(curDocs, yearDocs, { ...current, prevYearFactor: yf.missing ? null : yf.factor }),
    hours: localesByHour(curDocs),
    detail: Object.fromEntries(LOCALES.map(l => [l.id, localDetail({
      local: l, curDocs: of(curDocs, l.channel), prevDocs: of(yearDocs, l.channel), productsBySku, originBySku, factorByRefDate,
    })])),
    stockAsOf: today,
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getLocales(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildLocales(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
