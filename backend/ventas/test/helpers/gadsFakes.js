import request from 'supertest';
import { addDays } from '../../src/engine/dates.js';
import { createApp } from '../../src/app.js';
import { createAuthMiddleware } from '../../src/routes/authMiddleware.js';
import { createAdsRepo } from '../../src/repo/ads.js';
import { createAdsRouter } from '../../src/routes/ads.js';
import { createGadsRouter } from '../../src/routes/gads.js';
import { createExecutor, createIdentity } from '../../src/ads/agent.js';
import { createGoogleExecutor } from '../../src/gads/executor.js';
import { createGoogleAgentRunner } from '../../src/gads/agent.js';
import { createGoogleBaselineTaker } from '../../src/gads/baseline.js';
import { fakeMeta, fakeReports, config } from './adsFakes.js';

// Cliente falso de la Google Ads API: responde por patrón de la query (FROM …) con filas REST en camelCase.
// Tipo de query: 'purchase' (segmentada por conversion_action), 'metrics' (pide metrics.*) o 'structure'.
// Si la query selecciona segments.date, cada serie es [fin del BETWEEN, fin-8, fin-6, fin-7]: los índices 0 y 2 caen en
// la semana actual (fin-6 es su primer día) y 1 y 3 en la anterior (fin-7 es su último día).
// Las campañas eliminadas solo aparecen en las queries que no filtran campaign.status != 'REMOVED'.
export const CUSTOMER_ID = '8132886784';
const rn = (type, id) => `customers/${CUSTOMER_ID}/${type}/${id}`;
export const PURCHASE_ACTION = rn('conversionActions', 1);
const M = (pesos) => String(Math.round(pesos * 1e6));

const CONVERSION_ACTIONS = [
  { resourceName: rn('conversionActions', 3), name: 'Vista de página', category: 'PAGE_VIEW', primaryForGoal: true, status: 'ENABLED' },
  { resourceName: PURCHASE_ACTION, name: 'ALTORANCHO - GA4 (web) purchase', category: 'PURCHASE', primaryForGoal: true, status: 'ENABLED' },
  { resourceName: rn('conversionActions', 2), name: 'Compra (Tag de Google)', category: 'PURCHASE', primaryForGoal: false, status: 'ENABLED' },
];

const CAMPAIGNS = [
  { campaign: { id: '101', name: 'altorancho_search_marca', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', campaignBudget: rn('campaignBudgets', 501), maximizeConversionValue: {} }, campaignBudget: { amountMicros: M(20000) } },
  { campaign: { id: '102', name: 'altorancho_pmax_genérica_aon', status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', campaignBudget: rn('campaignBudgets', 502), maximizeConversionValue: { targetRoas: 4.5 } }, campaignBudget: { amountMicros: M(60000) } },
  { campaign: { id: '103', name: 'altorancho_demandgen_visitas', status: 'ENABLED', advertisingChannelType: 'DEMAND_GEN', biddingStrategyType: 'MAXIMIZE_CLICKS', campaignBudget: rn('campaignBudgets', 503) }, campaignBudget: { amountMicros: M(10000) } },
];

// Métricas diarias por campaña: [semana actual, semana anterior]
const CAMPAIGN_DAYS = {
  101: [{ costMicros: M(14000), clicks: '300', impressions: '4000', conversions: 12, allConversions: 30 }, { costMicros: M(10000), clicks: '200', impressions: '3000', conversions: 8, allConversions: 20 }],
  // Trampa: el total de conversiones (todas las primarias) es enorme; las compras reales son 69
  102: [{ costMicros: M(50000), clicks: '1200', impressions: '90000', conversions: 116557, allConversions: 116557 }, { costMicros: M(45000), clicks: '1000', impressions: '80000', conversions: 100000, allConversions: 100000 }],
  103: [
    { costMicros: M(8000), clicks: '900', impressions: '60000', conversions: 5000, allConversions: 5000 },
    { costMicros: M(7000), clicks: '700', impressions: '50000', conversions: 4000, allConversions: 4000 },
    { costMicros: M(1000), clicks: '100', impressions: '0' }, // hoy-6 → semana actual
    { costMicros: M(2000), clicks: '200', impressions: '0' }, // hoy-7 → semana anterior
  ],
  // Eliminada: no está en la lista de campañas pero su gasto de hoy cuenta
  104: [{ costMicros: M(5000), clicks: '10', impressions: '100' }],
};
const REMOVED_CAMPAIGN = { id: '104', name: 'altorancho_search_vieja', status: 'REMOVED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS' };
const CAMPAIGN_PURCHASES = {
  101: [{ allConversions: 3, allConversionsValue: 270000 }, { allConversions: 2, allConversionsValue: 150000 }],
  102: [{ allConversions: 69, allConversionsValue: 5400000 }, { allConversions: 40, allConversionsValue: 3000000 }],
};

const AD_GROUPS = [
  { adGroup: { id: '201', name: 'mantas', status: 'ENABLED' }, campaign: { id: '101', advertisingChannelType: 'SEARCH' } },
  { adGroup: { id: '202', name: 'deco_visitas', status: 'ENABLED' }, campaign: { id: '103', advertisingChannelType: 'DEMAND_GEN' } },
];
const AD_GROUP_METRICS = {
  201: { costMicros: M(14000), clicks: '300', impressions: '4000', conversions: 12 },
  202: { costMicros: M(8000), clicks: '900', impressions: '60000', conversions: 5000 },
};

const kw = (criterionId, text, matchType, status) => ({
  campaign: { id: '101' }, adGroup: { id: '201' },
  adGroupCriterion: { criterionId, status, keyword: { text, matchType } },
});
const KEYWORDS = [kw('301', 'mantas de lana', 'EXACT', 'ENABLED'), kw('302', 'almohadones', 'PHRASE', 'PAUSED'), kw('303', 'cortinas', 'BROAD', 'PAUSED')];
// Por palabra clave: [semana actual, semana anterior]
const KEYWORD_DAYS = {
  301: [{ costMicros: M(12000), clicks: '250', impressions: '3000' }, { costMicros: M(9000), clicks: '180', impressions: '2500' }],
  302: [null, { costMicros: M(1000), clicks: '20', impressions: '500' }],
};
const KEYWORD_PURCHASES = { 301: { allConversions: 3, allConversionsValue: 270000 } };

const term = (searchTerm, cost, clicks) => ({
  searchTermView: { searchTerm }, campaign: { id: '101' }, adGroup: { id: '201' },
  metrics: { costMicros: M(cost), clicks: String(clicks) },
});
const SEARCH_TERMS = [term('manta lana precio', 3000, 60), term('mantas de lana', 9000, 200), term('manta polar barata', 1500, 40)];
const SEARCH_TERM_PURCHASES = [{ searchTermView: { searchTerm: 'mantas de lana' }, campaign: { id: '101' }, adGroup: { id: '201' }, metrics: { allConversions: 3 } }];

// Anuncio de Demand Gen del grupo 202: de acá se copian logo y nombre del negocio
const DEMAND_GEN_ADS = [{
  adGroup: { id: '202' },
  adGroupAd: { ad: { demandGenMultiAssetAd: { logoImages: [{ asset: rn('assets', '800') }], businessName: 'Altorancho' } } },
}];

const ASSET_GROUPS = [{ assetGroup: { id: '401', name: 'genérica', status: 'ENABLED' }, campaign: { id: '102' } }];

function kindOf(q) {
  if (/segments\.conversion_action/.test(q)) return 'purchase';
  if (/metrics\./.test(q)) return 'metrics';
  return 'structure';
}
function datesOf(q) {
  const m = q.match(/segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
  if (!m) return null;
  const [, from, to] = m;
  const prevDay = addDays(to, -8);
  const inside = (d) => (d >= from ? d : null);
  return { from, to, days: [to, inside(prevDay), inside(addDays(to, -6)), inside(addDays(to, -7))] };
}
// Filas diarias (si se pide segments.date) o agregadas en el rango
function perDay(q, base, series) {
  const dates = datesOf(q);
  const daily = /SELECT[\s\S]*segments\.date[\s\S]*FROM/.test(q);
  const out = [];
  if (daily) {
    dates.days.forEach((d, i) => {
      if (d && series[i]) out.push({ ...base, segments: { ...(base.segments || {}), date: d }, metrics: series[i] });
    });
    return out;
  }
  const usable = dates ? series.filter((s, i) => dates.days[i]) : series;
  const agg = {};
  for (const s of usable) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s)) agg[k] = typeof v === 'string' ? String(Number(agg[k] || 0) + Number(v)) : (agg[k] || 0) + v;
  }
  return Object.keys(agg).length ? [{ ...base, metrics: agg }] : [];
}

export function fakeGoogleAds() {
  const calls = [];
  const queries = [];
  const gads = {
    customerId: CUSTOMER_ID,
    calls,
    queries,
    searchCount: 0,
    resource: (type, id) => rn(type, id),
    // Las condiciones de igualdad por id (campaign.id = N, ad_group.id = N, ad_group_criterion.criterion_id = N) filtran las filas
    search: async (q) => {
      gads.searchCount += 1;
      queries.push(q);
      const eq = (field) => (q.match(new RegExp(`${field.replace(/\./g, '\\.')} = (\\d+)`)) || [])[1];
      const want = [['campaign.id', (r) => r.campaign?.id], ['ad_group.id', (r) => r.adGroup?.id], ['ad_group_criterion.criterion_id', (r) => r.adGroupCriterion?.criterionId]]
        .map(([f, get]) => [eq(f), get]).filter(([v]) => v);
      const rows = await answer(q);
      return rows.filter((r) => want.every(([v, get]) => get(r) == null || String(get(r)) === v));
    },
    uploadImageAsset: async (buffer, name) => { calls.push(['uploadImageAsset', name]); return rn('assets', '700'); },
    createYoutubeAsset: async (youtubeId, name) => { calls.push(['createYoutubeAsset', youtubeId, name]); return rn('assets', '750'); },
    mutate: async (service, operations, opts = {}) => {
      calls.push(['mutate', service, operations, ...(Object.keys(opts).length ? [opts] : [])]);
      return { results: operations.map((_, i) => ({ resourceName: rn(service, `9${i}`) })) };
    },
  };
  async function answer(q) {
    const from = (q.match(/FROM\s+(\w+)/) || [])[1];
    const kind = kindOf(q);
    const action = (q.match(/segments\.conversion_action = '([^']+)'/) || [])[1];
    const isPurchase = action === PURCHASE_ACTION;
    const seg = { conversionAction: action };
    switch (from) {
      case 'conversion_action':
        return CONVERSION_ACTIONS.map((a) => ({ conversionAction: a }));
      case 'campaign':
        if (kind === 'structure') return CAMPAIGNS;
        if (kind === 'metrics') {
          const list = [...CAMPAIGNS.map((x) => x.campaign), REMOVED_CAMPAIGN].filter((c) => c.status !== 'REMOVED' || !q.includes("campaign.status != 'REMOVED'"));
          return list.flatMap((c) => perDay(q, { campaign: { id: c.id, name: c.name, advertisingChannelType: c.advertisingChannelType, biddingStrategyType: c.biddingStrategyType } }, CAMPAIGN_DAYS[c.id]));
        }
        if (!isPurchase) return [];
        return Object.entries(CAMPAIGN_PURCHASES).flatMap(([id, s]) => perDay(q, { campaign: { id }, segments: seg }, s));
      case 'ad_group':
        if (kind === 'structure') return AD_GROUPS;
        if (kind === 'metrics') return AD_GROUPS.map((g) => ({ adGroup: { id: g.adGroup.id }, campaign: { id: g.campaign.id }, metrics: AD_GROUP_METRICS[g.adGroup.id] }));
        return isPurchase ? [{ adGroup: { id: '201' }, campaign: { id: '101' }, segments: seg, metrics: { allConversions: 3, allConversionsValue: 270000 } }] : [];
      case 'keyword_view':
        if (kind === 'structure') return KEYWORDS;
        if (kind === 'metrics') {
          return KEYWORDS.flatMap((k) => perDay(q, { adGroup: k.adGroup, adGroupCriterion: { criterionId: k.adGroupCriterion.criterionId } }, KEYWORD_DAYS[k.adGroupCriterion.criterionId] || []));
        }
        return isPurchase
          ? Object.entries(KEYWORD_PURCHASES).map(([id, m]) => ({ adGroup: { id: '201' }, adGroupCriterion: { criterionId: id }, segments: seg, metrics: m }))
          : [];
      case 'search_term_view':
        if (kind === 'purchase') return isPurchase ? SEARCH_TERM_PURCHASES.map((r) => ({ ...r, segments: seg })) : [];
        return SEARCH_TERMS;
      case 'asset_group':
        return ASSET_GROUPS;
      case 'ad_group_ad':
        return DEMAND_GEN_ADS;
      default:
        throw new Error(`fakeGoogleAds: query sin respuesta: ${q}`);
    }
  }
  return gads;
}

// Panel con los dos agentes montados como en index.js: Meta en /api/ads y Google en /api/gads
export function buildGadsApp({ db, gads = fakeGoogleAds(), anthropic = null, meta = fakeMeta(), reports = fakeReports() }) {
  const metaRepo = createAdsRepo(db);
  const identity = createIdentity({ meta, config });
  const metaExecute = createExecutor({ meta, repo: metaRepo, config, identity });
  const repo = createAdsRepo(db, { platform: 'google' });
  const execute = gads ? createGoogleExecutor({ gads, repo }) : null;
  const startRun = gads && anthropic ? createGoogleAgentRunner({ anthropic, gads, repo, execute, log: { error: () => {} } }) : null;
  const takeBaseline = gads ? createGoogleBaselineTaker({ gads, repo }) : undefined;
  const app = createApp({
    apiRouter: [
      createAuthMiddleware({ password: 'pw' }),
      createAdsRouter({ repo: metaRepo, meta, reports, startRun: null, execute: metaExecute, identity, config }),
      createGadsRouter({ repo, gads, startRun, execute, config, takeBaseline }),
    ],
  });
  const call = (method, url) => request(app)[method](url).set('authorization', 'Bearer pw');
  return { repo, gads, call };
}
