// GET /api/v2/producto: categories, origin, best-selling models, "Pasar a la
// web", overstock and stock per location for the chosen period and channel.
// Stock is always today's; the web coverage and overstock windows count back
// from today, not from the period.
import { getPeriodRanges } from './periods.mjs';
import { ALL_CHANNELS } from './report.mjs';
import { querySalesByRange, getProductsBySku, getInflationIndexByMonth } from './firestore.mjs';
import { addDays, argDay, inflationFactor } from './events.mjs';
import { summarizeCategories, compareTopProducts } from './eventCategories.mjs';
import { summarizeOrigins } from './eventOrigins.mjs';
import { getOriginBySku } from './productOrigin.mjs';
import { webCoverage } from './stockCoverage.mjs';
import { CHANNEL_FILTERS, filterDocs, overstock, warehouses, modelStock, categoryStock } from './productTab.mjs';

const WEB_WINDOW_DAYS = 28;
const OVERSTOCK_WINDOW_DAYS = 56;
const month = (r) => r.start.slice(0, 7);

export async function buildProducto({ period = 'week', date, start, end, ch = 'all' }, { now = new Date() } = {}) {
  const channel = Object.hasOwn(CHANNEL_FILTERS, ch) ? ch : 'all';
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current, prevYear } = ranges;
  const today = argDay(now.toISOString());
  const webFrom = addDays(today, -(WEB_WINDOW_DAYS - 1));
  const overFrom = addDays(today, -(OVERSTOCK_WINDOW_DAYS - 1));

  const [curAll, prevYearAll, webDocs, recentDocs, productsBySku, indexByMonth, originBySku] = await Promise.all([
    querySalesByRange(ALL_CHANNELS, current.start, current.end),
    querySalesByRange(ALL_CHANNELS, prevYear.start, prevYear.end),
    querySalesByRange(['ecommerce'], webFrom, today),
    querySalesByRange(ALL_CHANNELS, overFrom, today),
    getProductsBySku(),
    getInflationIndexByMonth(),
    getOriginBySku().catch(err => { console.error('[producto] origin:', err.message); return null; }),
  ]);

  const cur = filterDocs(curAll, channel);
  const prev = filterDocs(prevYearAll, channel);
  const yf = inflationFactor(indexByMonth, month(prevYear), month(current));
  const factor = { get: () => (yf.missing ? 1 : yf.factor) };

  const catStock = categoryStock(productsBySku);
  const categories = summarizeCategories({ prevDocs: prev, prevToDateDocs: prev, currentDocs: cur, productsBySku, factorByRefDate: factor })
    .map(c => ({ ...c, stock: catStock.get(c.id) ?? 0 }));

  const stockByModel = modelStock(productsBySku);
  const topModels = compareTopProducts({ prevToDateDocs: prev, currentDocs: cur, productsBySku, factorByRefDate: factor, limit: 30 })
    .map(m => ({ ...m, stock: stockByModel.get(m.sku) ?? { total: 0, web: 0, byLoc: {} } }));

  return {
    range: current,
    ch: channel,
    prevYear: Number(prevYear.start.slice(0, 4)),
    inflationAdjusted: !yf.missing,
    categories,
    origins: originBySku?.size ? summarizeOrigins({ prevToDateDocs: prev, currentDocs: cur, originBySku, factorByRefDate: factor }) : null,
    topModels,
    coverage: webCoverage({ webSalesDocs: webDocs, productsBySku, windowDays: WEB_WINDOW_DAYS }),
    overstock: overstock({ salesDocs8w: recentDocs, productsBySku, windowDays: OVERSTOCK_WINDOW_DAYS }),
    warehouses: warehouses(productsBySku),
    stockAsOf: today,
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getProducto(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}|${params.ch || 'all'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildProducto(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
