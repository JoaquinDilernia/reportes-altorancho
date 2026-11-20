// GET /api/v3/pauta-real: el tablero de Pauta. Inversión, ventas (web +
// locales), ganancia bruta con el costo de Odoo, ROAS que dice cada
// plataforma vs. ROAS real (pedidos de la tienda atribuidos por gineza) y
// POAS por campaña. Si gineza u Odoo fallan, el resto se arma igual.
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, queryMetaAdsDailyByRange, queryGoogleAdsDailyByRange } from './firestore.mjs';
import { argDay } from './events.mjs';
import { webPlan } from './webReport.mjs';
import { getCostBySku } from './odooCosts.mjs';
import { getCustomerTypes } from './customerType.mjs';
import { getMarketingCosts, costForRange, monthlyCost } from './marketingCosts.mjs';
import { getPinterestStatus, queryPinterestDaily } from './pinterestAds.mjs';
import { isGinezaConfigured, fetchPaidAttribution, fetchSummary, fetchCampaigns, fetchTrackingChannels } from './gineza.mjs';
import { getPerfitSummary } from './perfit.mjs';
import {
  LOCAL_CHANNELS, headline, withDeltas, platformSpend, attributedOrders, platforms, webSources, campaigns, daily, customerMix, paidBlock,
} from './pautaRealTab.mjs';

// Pinterest por API: solo si alguna vez sincronizó bien (si no, se usa el gasto cargado a mano).
async function pinterestApiFor(current, prev) {
  try {
    const st = await getPinterestStatus();
    if (!st.connected) return null;
    const [cur, prv] = await Promise.all([queryPinterestDaily(current.start, current.end), queryPinterestDaily(prev.start, prev.end)]);
    return { cur, prev: prv };
  } catch (err) {
    console.error('[pauta-real] pinterest:', err.message);
    return null;
  }
}

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

  const [webCur, locCur, webPrev, locPrev, metaCur, gCur, metaPrev, gPrev, costs, gz, mkt, pinApi, track, perfitApi] = await Promise.all([
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
    getMarketingCosts().catch((err) => { console.error('[pauta-real] costos de marketing:', err.message); return null; }),
    pinterestApiFor(current, prevPeriodRange),
    // Nuestro seguimiento: compras por canal (último canal y "participó")
    isGinezaConfigured() ? fetchTrackingChannels(current.start, current.end).catch((err) => { console.error('[pauta-real] seguimiento:', err.message); return null; }) : null,
    getPerfitSummary(current, today).catch((err) => { console.error('[pauta-real] perfit:', err.message); return null; }),
  ]);

  const costBySku = costs.map;
  const spendBy = platformSpend(metaCur, gCur);
  const spendPrev = platformSpend(metaPrev, gPrev);
  // Pinterest (gasto cargado a mano por mes) suma a la inversión en pauta; el abono de Perfit no es pauta.
  // Con la API conectada, el gasto y "lo que dice Pinterest" salen de ahí; si no, el gasto cargado a mano.
  const sumOf = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const pin = pinApi ? { cost: Math.round(sumOf(pinApi.cur, 'spend')), missing: [], reported: sumOf(pinApi.cur, 'purchaseValue') } : costForRange(mkt, 'pinterest', current, today);
  const pinPrev = pinApi ? { cost: Math.round(sumOf(pinApi.prev, 'spend')) } : costForRange(mkt, 'pinterest', prevPeriodRange, today);
  const perfit = costForRange(mkt, 'perfit', current, today);
  const totalSpend = spendBy.meta.spend + spendBy.google.spend + (pin.cost || 0);
  const head = headline({ webDocs: webCur, localDocs: locCur, spend: totalSpend, costBySku });
  const headPrev = headline({ webDocs: webPrev, localDocs: locPrev, spend: spendPrev.meta.spend + spendPrev.google.spend + (pinPrev.cost || 0), costBySku });
  const fallback = head.fallbackCostRatio;

  const orders = gz.attribution ? attributedOrders(webCur, gz.attribution, costBySku, fallback) : [];
  const extraOrders = gz.attribution ? attributedOrders(webCur, gz.attribution, costBySku, fallback, ['pinterest', 'email']) : [];
  const month = (current.end < today ? current.end : today).slice(0, 7);
  const extraBlock = (channel, key, c) => ({
    ...paidBlock({ spend: c.cost, reportedValue: c.reported ?? null, orders: extraOrders.filter((o) => o.channel === channel) }),
    source: c.reported != null ? 'api' : 'manual',
    cost: { key, month, monthly: monthlyCost(mkt, key, month), missing: c.missing, loaded: mkt != null },
  });

  const result = {
    range: current,
    prevPeriodRange,
    headline: withDeltas(head, headPrev),
    platforms: gz.attribution ? platforms({ spendBy, orders }) : null,
    platformSpend: spendBy,
    // Canales sin API de gasto: costo cargado a mano (Pinterest) o abono fijo (Perfit)
    others: gz.attribution ? { pinterest: extraBlock('pinterest', 'pinterest', pin), email: extraBlock('email', 'perfit', perfit) } : null,
    sources: webSources({ webDocs: webCur, orders, summaryChannels: gz.summary?.channels }),
    campaigns: gz.camp ? {
      meta: campaigns({ rows: gz.camp.meta, orders, platform: 'meta' }),
      google: campaigns({ rows: gz.camp.google, orders, platform: 'google' }),
    } : null,
    coverage: gz.summary ? { meta: gz.summary.coverage, google: gz.summary.google?.coverage } : null,
    // un período en curso se dibuja hasta hoy, sin días vacíos a la derecha
    daily: daily({ range: { start: current.start, end: current.end < today ? current.end : today }, webDocs: webCur, localDocs: locCur, metaDaily: metaCur, googleDaily: gCur, costBySku, fallback }),
    tracking: track ? {
      since: track.trackingSince,
      byChannel: Object.fromEntries(track.channels.map((c) => [c.channel, { visits: c.visits, orders: c.orders, revenue: c.revenue, assistedOrders: c.assistedOrders, assistedRevenue: c.assistedRevenue }])),
    } : null,
    perfit: perfitApi ? { campaignTotals: perfitApi.campaignTotals, automationTotals: perfitApi.automationTotals, automationsSince: perfitApi.automationsSince } : null,
    errors: { attribution: gz.error, costs: costs.error },
    generatedAt: now.toISOString(),
  };
  // Para el endpoint de clientes (no viajan en el JSON): pedidos atribuidos y ventas web.
  Object.defineProperty(result, 'internal', { value: { orders, webDocs: webCur, spendBy, today, attributed: Boolean(gz.attribution) }, enumerable: false });
  return result;
}

// GET /api/v3/pauta-real/clientes: nuevos vs. recurrentes. Aparte porque
// preguntarle a Tienda Nube la historia de cada cliente tarda (~1 min la
// primera vez de un período) y el resto del tablero no tiene que esperarlo.
export async function getPautaClientes(params) {
  const pr = await getPautaReal(params);
  const { orders, webDocs, spendBy, today, attributed } = pr.internal;
  const typeByOrder = await getCustomerTypes(pr.range, today);
  return { range: pr.range, attributed, ...customerMix({ webDocs, typeByOrder, orders, spendBy }) };
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export const clearPautaRealCache = () => cache.clear();

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
