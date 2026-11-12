// GET /api/v2/resumen: reads every source the Resumen needs and hands the
// pieces to the pure functions in resumen.mjs / alerts.mjs / stockCoverage.mjs.
// GA4, Clarity and the product origin are optional: if one fails the Resumen
// still renders and `sources` says what's missing.
import { getPeriodRanges } from './periods.mjs';
import { computeTotals } from './aggregate.mjs';
import { ALL_CHANNELS } from './report.mjs';
import {
  querySalesByRange, queryMetaAdsDailyByRange, queryGoogleAdsDailyByRange, getProductsBySku,
  getInflationIndexByMonth, queryDailySnapshots, CLARITY_DAILY_COL,
} from './firestore.mjs';
import { addDays, argDay, inflationFactor } from './events.mjs';
import { sparkRanges, channelBreakdown, dailyStacked, buildKpis, summaryPlan, isSettled } from './resumen.mjs';
import { buildAlerts } from './alerts.mjs';
import { ALERTS } from './alertConfig.mjs';
import { webCoverage } from './stockCoverage.mjs';
import { getWebBehavior } from './eventBehavior.mjs';
import { fetchGa4DailyTotals, isGa4Configured } from './ga4.mjs';
import { getOriginBySku } from './productOrigin.mjs';
import { summarizeOrigins } from './eventOrigins.mjs';

const STORES = [
  { id: 'lomas', label: 'Lomas', channel: 'local_lomas' },
  { id: 'belgrano', label: 'Belgrano', channel: 'local_belgrano' },
  { id: 'alcorta', label: 'Alcorta', channel: 'local_alcorta' },
];
const WEB_WINDOW_DAYS = 28;

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const byDate = (rows, r) => rows.filter(x => x.date >= r.start && x.date <= r.end);
const month = (r) => r.start.slice(0, 7);

function adsTotals(rows) {
  return rows.reduce((t, x) => ({ spend: t.spend + (x.spend || 0), value: t.value + (x.purchaseValue || 0) }), { spend: 0, value: 0 });
}

function webTotals(dailyMap, r) {
  let sessions = 0;
  let purchases = 0;
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) {
    const x = dailyMap.get(d);
    if (x) { sessions += x.sessions; purchases += x.purchases; }
  }
  return { sessions, purchases };
}

// The previous `n` periods (weeks / calendar months / same-length ranges).
function baselineRanges(ranges, period) {
  const n = ALERTS.localBaselinePeriods[period] ?? ALERTS.localBaselinePeriods.custom;
  if (period === 'month') return sparkRanges(ranges, 'month').slice(-1 - n, -1);
  return sparkRanges(ranges, period, n + 1).slice(0, n);
}

// Totals of a range, overall and per channel. Sparklines and baselines need a
// year of history (~57k sales docs for 12 months): settled ranges (see
// summaryPlan) are kept for 24 h — a late cancellation lags a day, which is fine.
const pick = (t) => ({ revenue: t.revenue, orders: t.orders, avgTicket: t.avgTicket });
function summarize(docs) {
  return {
    totals: pick(computeTotals(docs)),
    byChannel: Object.fromEntries(ALL_CHANNELS.map(ch => [ch, pick(computeTotals(docs.filter(d => d.channel === ch)))])),
  };
}
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
const summaryCache = new Map();
function rangeSummary(r, now) {
  const plan = summaryPlan(r, now);
  if (!plan.cache) return querySalesByRange(ALL_CHANNELS, r.start, r.end).then(summarize);
  const key = `${r.start}|${r.end}`;
  const hit = summaryCache.get(key);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.promise;
  const promise = querySalesByRange(ALL_CHANNELS, r.start, r.end, { fresh: plan.fresh }).then(summarize);
  if (summaryCache.size > 200) summaryCache.delete(summaryCache.keys().next().value);
  summaryCache.set(key, { at: Date.now(), promise });
  promise.catch(() => summaryCache.delete(key));
  return promise;
}

// Each store vs. its own average of the previous periods (months adjusted
// by inflation to the current month).
function localsVsBaseline({ curDocs, base, baseSummaries, ranges, period, indexByMonth }) {
  return STORES.map(s => {
    const t = computeTotals(curDocs.filter(d => d.channel === s.channel));
    let revenue = 0;
    let orders = 0;
    for (const [i, r] of base.entries()) {
      const bt = baseSummaries[i].byChannel[s.channel];
      const f = period === 'month' ? inflationFactor(indexByMonth, month(r), month(ranges.current)).factor : 1;
      revenue += bt.revenue * f;
      orders += bt.orders;
    }
    return {
      id: s.id, label: s.label,
      revenue: t.revenue, orders: t.orders, avgTicket: t.avgTicket,
      baselineRevenue: revenue / base.length,
      baselineOrders: orders / base.length,
      baselineAvgTicket: orders ? revenue / orders : 0,
    };
  });
}

export async function buildResumen({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current, prevPeriod, prevYear } = ranges;
  const today = argDay(now.toISOString());
  const sparks = sparkRanges(ranges, period);
  const base = baselineRanges(ranges, period);
  const spanStart = sparks[0].start;
  const webWindow = { start: addDays(today, -(WEB_WINDOW_DAYS - 1)), end: today };
  const ga4 = isGa4Configured();

  const [curDocs, prevDocs, sparkSummaries, baseSummaries, prevYearDocs, webDocs, productsBySku, indexByMonth, meta, google, behavior, gaDaily, clarity, originBySku] = await Promise.all([
    querySalesByRange(ALL_CHANNELS, current.start, current.end),
    querySalesByRange(ALL_CHANNELS, prevPeriod.start, prevPeriod.end),
    Promise.all(sparks.map(r => rangeSummary(r, now))),
    Promise.all(base.map(r => rangeSummary(r, now))),
    querySalesByRange(ALL_CHANNELS, prevYear.start, prevYear.end),
    querySalesByRange(['ecommerce'], webWindow.start, webWindow.end),
    getProductsBySku(),
    getInflationIndexByMonth(),
    queryMetaAdsDailyByRange(spanStart, current.end),
    queryGoogleAdsDailyByRange(spanStart, current.end),
    ga4 ? getWebBehavior({ cur: current, prev: prevPeriod, yoy: prevYear }).catch(err => { console.error('[resumen] GA4:', err.message); return null; }) : null,
    ga4 ? fetchGa4DailyTotals(sparks[0].start, current.end).catch(err => { console.error('[resumen] GA4 daily:', err.message); return null; }) : null,
    queryDailySnapshots(CLARITY_DAILY_COL, current.start, current.end).catch(err => { console.error('[resumen] clarity:', err.message); return null; }),
    getOriginBySku().catch(err => { console.error('[resumen] origin:', err.message); return null; }),
  ]);

  const adsRows = [...meta, ...google];
  const currentIndex = indexByMonth.get(month(current));
  const prevYearIndex = indexByMonth.get(month(prevYear));
  const yearFactor = inflationFactor(indexByMonth, month(prevYear), month(current));
  const prevYearFactor = yearFactor.missing ? null : yearFactor.factor;

  const web = behavior && gaDaily ? {
    cur: behavior.totals.cur, prev: behavior.totals.prev, yoy: behavior.totals.yoy ?? null,
    spark: sparks.map(r => webTotals(gaDaily, r)),
  } : null;

  const kpis = buildKpis({
    cur: computeTotals(curDocs),
    prevPeriod: computeTotals(prevDocs),
    prevYear: computeTotals(prevYearDocs),
    sparks: sparkSummaries.map(x => x.totals),
    inflation: { currentIndex, prevYearIndex },
    web,
    ads: { cur: adsTotals(byDate(adsRows, current)), prev: adsTotals(byDate(adsRows, prevPeriod)), spark: sparks.map(r => adsTotals(byDate(adsRows, r))) },
  });

  // A period still running would always look "down" against full ones, so the
  // comparisons that need a closed period (stores, origin) wait until its
  // last day has synced.
  const closed = isSettled(current.end, now);
  const origins = closed && originBySku?.size
    ? summarizeOrigins({ prevToDateDocs: prevYearDocs, currentDocs: curDocs, originBySku, factorByRefDate: { get: () => prevYearFactor ?? 1 } })
    : null;
  const alerts = buildAlerts({
    period,
    days: daysBetween(current.start, current.end) + 1,
    locales: closed ? localsVsBaseline({ curDocs, base, baseSummaries, ranges, period, indexByMonth }) : null,
    coverage: webCoverage({ webSalesDocs: webDocs, productsBySku, windowDays: WEB_WINDOW_DAYS, maxCoverageDays: ALERTS.coverageDays }),
    behavior,
    clarity,
    origins,
  });

  return {
    range: current,
    ranges: { current, prevPeriod, prevYear },
    kpis,
    alerts,
    channels: channelBreakdown(curDocs, prevDocs),
    daily: dailyStacked(curDocs, prevYearDocs, { start: current.start, end: current.end, prevYearFactor }),
    stockAsOf: today,
    sources: { ga4: !!behavior, clarityDays: clarity?.length ?? 0 },
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getResumen(params) {
  const key = JSON.stringify([params.period, params.date, params.start, params.end]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildResumen(params);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
