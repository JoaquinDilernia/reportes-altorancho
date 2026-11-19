// GET /api/v3/pauta-real: el tablero de Pauta. Inversión, ventas (web +
// locales), ganancia bruta con el costo de Odoo, ROAS que dice cada
// plataforma vs. ROAS real (pedidos de la tienda atribuidos por gineza) y
// POAS por campaña. Si gineza u Odoo fallan, el resto se arma igual.
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, queryMetaAdsDailyByRange, queryGoogleAdsDailyByRange } from './firestore.mjs';
import { argDay } from './events.mjs';
import { webPlan } from './webReport.mjs';
import { getCostBySku } from './odooCosts.mjs';
import { isGinezaConfigured, fetchPaidAttribution, fetchSummary, fetchCampaigns } from './gineza.mjs';
import {
  LOCAL_CHANNELS, headline, withDeltas, platformSpend, attributedOrders, platforms, webSources, campaigns, daily,
} from './pautaRealTab.mjs';

async function ginezaFor(range) {
  if (!isGinezaConfigured()) return { error: 'La atribución por campaña no está conectada (falta GINEZA_PASSWORD)' };
  try {
    const [attribution, summary, camp] = await Promise.all([
      fetchPaidAttribution(range.start, range.end),
      fetchSummary(range.start, range.end),
      fetchCampaigns(range.start, range.end),
    ]);
    return { attribution, summary, camp, error: null };
  } catch (err) {
    console.error('[pauta-real] gineza:', err.message);
    return { error: 'La atribución por campaña no respondió' };
  }
}

export async function buildPautaReal({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const today = argDay(now.toISOString());
  const { prevPeriodRange } = webPlan(ranges, today);

  const [webCur, locCur, webPrev, locPrev, metaCur, gCur, metaPrev, gPrev, costs, gz] = await Promise.all([
    querySalesByRange(['ecommerce'], current.start, current.end),
    querySalesByRange(LOCAL_CHANNELS, current.start, current.end),
    querySalesByRange(['ecommerce'], prevPeriodRange.start, prevPeriodRange.end),
    querySalesByRange(LOCAL_CHANNELS, prevPeriodRange.start, prevPeriodRange.end),
    queryMetaAdsDailyByRange(current.start, current.end),
    queryGoogleAdsDailyByRange(current.start, current.end),
    queryMetaAdsDailyByRange(prevPeriodRange.start, prevPeriodRange.end),
    queryGoogleAdsDailyByRange(prevPeriodRange.start, prevPeriodRange.end),
    getCostBySku().then((m) => ({ map: m, error: null })).catch((err) => {
      console.error('[pauta-real] odoo costs:', err.message);
      return { map: new Map(), error: 'No se pudieron leer los costos de Odoo' };
    }),
    ginezaFor(current),
  ]);

  const costBySku = costs.map;
  const spendBy = platformSpend(metaCur, gCur);
  const spendPrev = platformSpend(metaPrev, gPrev);
  const totalSpend = spendBy.meta.spend + spendBy.google.spend;
  const head = headline({ webDocs: webCur, localDocs: locCur, spend: totalSpend, costBySku });
  const headPrev = headline({ webDocs: webPrev, localDocs: locPrev, spend: spendPrev.meta.spend + spendPrev.google.spend, costBySku });
  const fallback = head.fallbackCostRatio;

  const orders = gz.attribution ? attributedOrders(webCur, gz.attribution, costBySku, fallback) : [];

  return {
    range: current,
    prevPeriodRange,
    headline: withDeltas(head, headPrev),
    platforms: gz.attribution ? platforms({ spendBy, orders }) : null,
    platformSpend: spendBy,
    sources: webSources({ webDocs: webCur, orders, summaryChannels: gz.summary?.channels }),
    campaigns: gz.camp ? {
      meta: campaigns({ rows: gz.camp.meta, orders, platform: 'meta' }),
      google: campaigns({ rows: gz.camp.google, orders, platform: 'google' }),
    } : null,
    coverage: gz.summary ? { meta: gz.summary.coverage, google: gz.summary.google?.coverage } : null,
    // un período en curso se dibuja hasta hoy, sin días vacíos a la derecha
    daily: daily({ range: { start: current.start, end: current.end < today ? current.end : today }, webDocs: webCur, localDocs: locCur, metaDaily: metaCur, googleDaily: gCur, costBySku, fallback }),
    errors: { attribution: gz.error, costs: costs.error },
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export function getPautaReal(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildPautaReal(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
