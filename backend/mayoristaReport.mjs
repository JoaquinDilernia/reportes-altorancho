// GET /api/v2/mayorista: mayorista + ferias for the chosen period — KPIs,
// collected vs. invoiced, the mayorista/ferias split, ferias by sales team,
// sales per day and the best-selling models with today's stock.
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getProductsBySku, getInflationIndexByMonth } from './firestore.mjs';
import { argDay, inflationFactor } from './events.mjs';
import { dailyStacked } from './resumen.mjs';
import { compareTopProducts } from './eventCategories.mjs';
import { modelStock } from './productTab.mjs';
import { webPlan } from './webReport.mjs';
import { SOURCES, mayoristaSummary, feriaTeams } from './mayoristaTab.mjs';

const CHANNELS = SOURCES.map(s => s.id);
const month = (r) => r.start.slice(0, 7);

export async function buildMayorista({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const today = argDay(now.toISOString());
  const { prevRange, prevPeriodRange } = webPlan(ranges, today);

  const [curDocs, prevDocs, yearDocs, productsBySku, indexByMonth] = await Promise.all([
    querySalesByRange(CHANNELS, current.start, current.end),
    querySalesByRange(CHANNELS, prevPeriodRange.start, prevPeriodRange.end),
    querySalesByRange(CHANNELS, prevRange.start, prevRange.end),
    getProductsBySku(),
    getInflationIndexByMonth(),
  ]);

  const yf = inflationFactor(indexByMonth, month(prevRange), month(current));
  const factorByRefDate = { get: () => (yf.missing ? 1 : yf.factor) };
  const stockByModel = modelStock(productsBySku);

  return {
    range: current,
    prevRange,
    prevPeriodRange,
    prevYear: Number(prevRange.start.slice(0, 4)),
    inflationAdjusted: !yf.missing,
    summary: mayoristaSummary({
      curDocs, prevDocs, yearDocs,
      inflation: { currentIndex: indexByMonth.get(month(current)), prevYearIndex: indexByMonth.get(month(prevRange)) },
    }),
    feriaTeams: feriaTeams(curDocs),
    daily: dailyStacked(curDocs, yearDocs, { ...current, prevYearFactor: yf.missing ? null : yf.factor }),
    topModels: compareTopProducts({ prevToDateDocs: yearDocs, currentDocs: curDocs, productsBySku, factorByRefDate, limit: 20 })
      .map(m => ({ ...m, stock: stockByModel.get(m.sku) ?? { total: 0, web: 0, tn: 0, byLoc: {} } })),
    stockAsOf: today,
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getMayorista(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildMayorista(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
