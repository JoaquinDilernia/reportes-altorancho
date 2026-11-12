// GET /api/v2/pauta: Meta and Google together for the chosen period, best and
// worst Meta ads, and Google campaigns. Meta and Google totals come from the
// daily Firestore docs; campaigns are a live call (Google Ads + GA4), cached,
// and optional: if they fail the rest still renders.
import { getPeriodRanges } from './periods.mjs';
import { queryMetaAdsDailyByRange, queryMetaAdsAdDailyByRange, queryGoogleAdsDailyByRange, getInflationIndexByMonth } from './firestore.mjs';
import { argDay } from './events.mjs';
import { isGoogleAdsConfigured, fetchGoogleCampaignCosts } from './googleAds.mjs';
import { isGa4Configured, fetchGa4GoogleAdsByCampaign } from './ga4.mjs';
import { webPlan } from './webReport.mjs';
import { pautaSummary, pautaDaily, adRankings, googleCampaigns } from './pautaTab.mjs';

const month = (r) => r.start.slice(0, 7);
const CAMPAIGNS_CLOSED_TTL_MS = 6 * 3600 * 1000;
const CAMPAIGNS_RUNNING_TTL_MS = 15 * 60 * 1000;
const campaignCache = new Map();

async function campaignsFor(range, today) {
  if (!isGoogleAdsConfigured()) return { campaigns: null, campaignsError: 'Google Ads no configurado' };
  const key = `${range.start}|${range.end}`;
  const ttl = range.end < today ? CAMPAIGNS_CLOSED_TTL_MS : CAMPAIGNS_RUNNING_TTL_MS;
  const hit = campaignCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = Promise.all([
    fetchGoogleCampaignCosts(range.start, range.end),
    isGa4Configured() ? fetchGa4GoogleAdsByCampaign(range.start, range.end) : [],
  ])
    .then(([costs, ga4]) => ({ campaigns: googleCampaigns(costs, ga4), campaignsError: null }))
    .catch(err => {
      console.error('[pauta] campaigns:', err.message);
      campaignCache.delete(key);
      return { campaigns: null, campaignsError: 'Google Ads no respondió' };
    });
  if (campaignCache.size > 40) campaignCache.delete(campaignCache.keys().next().value);
  campaignCache.set(key, { at: Date.now(), promise });
  return promise;
}

export async function buildPauta({ period = 'week', date, start, end }, { now = new Date() } = {}) {
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const { current } = ranges;
  const today = argDay(now.toISOString());
  const { prevRange, prevPeriodRange } = webPlan(ranges, today);

  const [metaCur, metaPrev, metaYear, gCur, gPrev, gYear, adRows, indexByMonth, camp] = await Promise.all([
    queryMetaAdsDailyByRange(current.start, current.end),
    queryMetaAdsDailyByRange(prevPeriodRange.start, prevPeriodRange.end),
    queryMetaAdsDailyByRange(prevRange.start, prevRange.end),
    queryGoogleAdsDailyByRange(current.start, current.end),
    queryGoogleAdsDailyByRange(prevPeriodRange.start, prevPeriodRange.end),
    queryGoogleAdsDailyByRange(prevRange.start, prevRange.end),
    queryMetaAdsAdDailyByRange(current.start, current.end),
    getInflationIndexByMonth(),
    campaignsFor(current, today),
  ]);

  return {
    range: current,
    prevRange,
    prevPeriodRange,
    prevYear: Number(prevRange.start.slice(0, 4)),
    summary: pautaSummary({
      meta: { cur: metaCur, prev: metaPrev, year: metaYear },
      google: { cur: gCur, prev: gPrev, year: gYear },
      inflation: { currentIndex: indexByMonth.get(month(current)), prevYearIndex: indexByMonth.get(month(prevRange)) },
    }),
    daily: pautaDaily(metaCur, gCur, current),
    ads: adRankings(adRows),
    ...camp,
    generatedAt: now.toISOString(),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function getPauta(params) {
  const { current } = params.period === 'custom' ? getPeriodRanges(params.start, 'custom', params.end) : getPeriodRanges(params.date, params.period);
  const key = `${current.start}|${current.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = buildPauta(params);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
