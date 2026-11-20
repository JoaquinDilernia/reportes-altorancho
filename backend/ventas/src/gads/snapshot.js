import { artDate, addDays } from '../engine/dates.js';
import { googleFamily, familyMetrics } from '../ads/families.js';

// La API devuelve int64 como string y doubles como number: todo pasa a Number
export const num = (v) => (v == null || v === '' ? 0 : Number(v));
// cost_micros → pesos redondeados
export const pesos = (micros) => Math.round(num(micros) / 1e6);

// Literal seguro para GAQL (resource names y fechas no llevan comillas; si llegan, se rechazan)
export function lit(v) {
  const s = String(v);
  if (/['\\]/.test(s)) throw new Error(`Valor inválido para GAQL: ${s}`);
  return `'${s}'`;
}
export const between = (from, to) => `segments.date BETWEEN ${lit(from)} AND ${lit(to)}`;

// Métricas crudas acumulables (costo en micros para no perder precisión al sumar)
export const emptyRaw = () => ({ costMicros: 0, clicks: 0, impressions: 0, purchases: 0, purchaseValue: 0 });
export function addMetrics(raw, m = {}) {
  raw.costMicros += num(m.costMicros);
  raw.clicks += num(m.clicks);
  raw.impressions += num(m.impressions);
  return raw;
}
export function addPurchases(raw, m = {}) {
  raw.purchases += num(m.allConversions);
  raw.purchaseValue += num(m.allConversionsValue);
  return raw;
}
export const toFamilyMetrics = (family, raw = emptyRaw()) => familyMetrics(family, {
  spend: pesos(raw.costMicros), clicks: raw.clicks, impressions: raw.impressions,
  purchases: Math.round(raw.purchases * 100) / 100, purchaseValue: Math.round(raw.purchaseValue),
});

const getRaw = (map, key) => {
  if (!map.has(key)) map.set(key, emptyRaw());
  return map.get(key);
};
const idFromResource = (rn) => (rn ? String(rn).split('/').pop() : null);

// Foto de la cuenta de Google: estructura en vivo + métricas de la plataforma por objetivo.
// Las compras salen SOLO de la acción de compra elegida (all_conversions segmentado por conversion_action),
// nunca de metrics.conversions (que mezcla todas las primarias). ≤ 12 llamadas a search.
export async function buildGoogleSnapshot({ gads, purchaseAction, now = new Date() }) {
  const today = artDate(now);
  const w7 = { from: addDays(today, -6), to: today };
  const prev = { from: addDays(today, -13), to: addDays(today, -7) };
  const d14 = { from: addDays(today, -13), to: today };
  const monthFrom = `${today.slice(0, 7)}-01`;
  const wide = { from: monthFrom < d14.from ? monthFrom : d14.from, to: today };
  const pa = purchaseAction?.resourceName ? lit(purchaseAction.resourceName) : null;
  const paWhere = pa ? `segments.conversion_action = ${pa}` : null;
  const purchasesQ = (q) => (pa ? gads.search(q) : Promise.resolve([]));

  const kwWhere = `ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'
  AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'SEARCH'`;
  const agWhere = `ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND campaign.advertising_channel_type IN ('SEARCH', 'DEMAND_GEN')`;
  const stWhere = `campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'`;
  // En las queries de métricas no se filtra por estado: lo eliminado también gastó (tope mensual, gasto de hoy).
  // El filtro de estado queda solo en las de estructura (las listas de objetos).
  const kwMetricWhere = `ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND campaign.advertising_channel_type = 'SEARCH'`;
  const agMetricWhere = `campaign.advertising_channel_type IN ('SEARCH', 'DEMAND_GEN')`;

  const [
    campaignRows, campaignMetricRows, campaignPurchaseRows,
    adGroupRows, adGroupMetricRows, adGroupPurchaseRows,
    keywordRows, keywordMetricRows, keywordPurchaseRows,
    termRows, termPurchaseRows, assetGroupRows,
  ] = await Promise.all([
    gads.search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
  campaign.campaign_budget, campaign_budget.amount_micros, campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas
FROM campaign
WHERE campaign.status != 'REMOVED'`),
    gads.search(`SELECT campaign.id, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions
FROM campaign
WHERE ${between(wide.from, wide.to)}`),
    purchasesQ(`SELECT campaign.id, segments.date, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value
FROM campaign
WHERE ${between(wide.from, wide.to)} AND ${paWhere}`),
    gads.search(`SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.advertising_channel_type
FROM ad_group
WHERE ${agWhere}`),
    gads.search(`SELECT ad_group.id, campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions
FROM ad_group
WHERE ${agMetricWhere} AND ${between(w7.from, w7.to)}`),
    purchasesQ(`SELECT ad_group.id, campaign.id, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value
FROM ad_group
WHERE ${agMetricWhere} AND ${between(w7.from, w7.to)} AND ${paWhere}`),
    gads.search(`SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
  ad_group_criterion.keyword.match_type, ad_group_criterion.status
FROM keyword_view
WHERE ${kwWhere}`),
    gads.search(`SELECT ad_group.id, ad_group_criterion.criterion_id, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions
FROM keyword_view
WHERE ${kwMetricWhere} AND ${between(d14.from, d14.to)}`),
    purchasesQ(`SELECT ad_group.id, ad_group_criterion.criterion_id, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value
FROM keyword_view
WHERE ${kwMetricWhere} AND ${between(w7.from, w7.to)} AND ${paWhere}`),
    gads.search(`SELECT search_term_view.search_term, campaign.id, ad_group.id, metrics.cost_micros, metrics.clicks
FROM search_term_view
WHERE ${stWhere} AND ${between(d14.from, d14.to)} AND metrics.cost_micros > 0
ORDER BY metrics.cost_micros DESC
LIMIT 1000`),
    purchasesQ(`SELECT search_term_view.search_term, campaign.id, ad_group.id, segments.conversion_action, metrics.all_conversions
FROM search_term_view
WHERE ${between(d14.from, d14.to)} AND ${paWhere}`),
    gads.search(`SELECT asset_group.id, asset_group.name, asset_group.status, campaign.id
FROM asset_group
WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`),
  ]);

  // Campañas: métricas por ventana (7d / semana anterior / hoy / mes) a partir de filas diarias
  const inRange = (d, r) => d >= r.from && d <= r.to;
  const c7 = new Map(); const cPrev = new Map();
  const todayRaw = emptyRaw(); const monthRaw = emptyRaw();
  const bucket = (row, add) => {
    const id = String(row.campaign?.id);
    const d = row.segments?.date;
    if (inRange(d, w7)) add(getRaw(c7, id), row.metrics);
    if (inRange(d, prev)) add(getRaw(cPrev, id), row.metrics);
    if (d === today) add(todayRaw, row.metrics);
    if (d >= monthFrom && d <= today) add(monthRaw, row.metrics);
  };
  for (const r of campaignMetricRows) bucket(r, addMetrics);
  for (const r of campaignPurchaseRows) bucket(r, addPurchases);

  const familyByCampaign = new Map();
  const campaigns = campaignRows.map((r) => {
    const c = r.campaign || {};
    const id = String(c.id);
    const family = googleFamily({ advertisingChannelType: c.advertisingChannelType, biddingStrategyType: c.biddingStrategyType });
    familyByCampaign.set(id, family);
    const targetRoas = c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas ?? null;
    return {
      id, name: c.name, status: c.status, channelType: c.advertisingChannelType, biddingStrategyType: c.biddingStrategyType,
      targetRoas: targetRoas == null ? null : Number(targetRoas),
      budgetId: idFromResource(c.campaignBudget),
      dailyBudgetArs: r.campaignBudget?.amountMicros != null ? pesos(r.campaignBudget.amountMicros) : null,
      family,
      platform7d: toFamilyMetrics(family, c7.get(id)),
      platformPrev7d: toFamilyMetrics(family, cPrev.get(id)),
    };
  });
  campaigns.sort((a, b) => (b.platform7d.spend - a.platform7d.spend) || (a.name || '').localeCompare(b.name || ''));
  const famOf = (campaignId) => familyByCampaign.get(String(campaignId)) ?? 'engagement';

  // Grupos de anuncios (Search y Demand Gen)
  const ag7 = new Map();
  for (const r of adGroupMetricRows) addMetrics(getRaw(ag7, String(r.adGroup?.id)), r.metrics);
  for (const r of adGroupPurchaseRows) addPurchases(getRaw(ag7, String(r.adGroup?.id)), r.metrics);
  const adGroups = adGroupRows.map((r) => {
    const id = String(r.adGroup?.id);
    const campaignId = String(r.campaign?.id);
    const family = famOf(campaignId);
    return { id, name: r.adGroup?.name, campaignId, status: r.adGroup?.status, family, platform7d: toFamilyMetrics(family, ag7.get(id)) };
  });

  // Palabras clave: id compuesto '<adGroupId>~<criterionId>'; solo activas o con costo en 14 días
  const kwId = (r) => `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`;
  const kw7 = new Map(); const kwCost14 = new Map();
  for (const r of keywordMetricRows) {
    const id = kwId(r);
    kwCost14.set(id, (kwCost14.get(id) || 0) + num(r.metrics?.costMicros));
    if (inRange(r.segments?.date, w7)) addMetrics(getRaw(kw7, id), r.metrics);
  }
  for (const r of keywordPurchaseRows) addPurchases(getRaw(kw7, kwId(r)), r.metrics);
  const keywords = keywordRows
    .filter((r) => r.adGroupCriterion?.status === 'ENABLED' || (kwCost14.get(kwId(r)) || 0) > 0)
    .map((r) => {
      const id = kwId(r);
      const campaignId = String(r.campaign?.id);
      return {
        id, text: r.adGroupCriterion?.keyword?.text, matchType: r.adGroupCriterion?.keyword?.matchType,
        adGroupId: String(r.adGroup?.id), campaignId, status: r.adGroupCriterion?.status,
        platform7d: toFamilyMetrics(famOf(campaignId), kw7.get(id)),
      };
    });
  keywords.sort((a, b) => b.platform7d.spend - a.platform7d.spend);

  // Términos de búsqueda: top 50 por costo en 14 días con costo > 0 y 0 compras
  const termKey = (r) => `${r.campaign?.id}|${r.adGroup?.id}|${r.searchTermView?.searchTerm}`;
  const termPurchases = new Map();
  for (const r of termPurchaseRows) termPurchases.set(termKey(r), (termPurchases.get(termKey(r)) || 0) + num(r.metrics?.allConversions));
  const termAgg = new Map();
  for (const r of termRows) {
    const k = termKey(r);
    const t = termAgg.get(k) || { term: r.searchTermView?.searchTerm, campaignId: String(r.campaign?.id), adGroupId: String(r.adGroup?.id), costMicros: 0, clicks: 0 };
    t.costMicros += num(r.metrics?.costMicros);
    t.clicks += num(r.metrics?.clicks);
    termAgg.set(k, t);
  }
  const searchTerms = [...termAgg.entries()]
    .filter(([k, t]) => t.costMicros > 0 && !(termPurchases.get(k) > 0))
    .map(([, t]) => t)
    .sort((a, b) => b.costMicros - a.costMicros)
    .slice(0, 50)
    .map((t) => ({ term: t.term, campaignId: t.campaignId, adGroupId: t.adGroupId, spend: pesos(t.costMicros), clicks: t.clicks }));

  const assetGroups = assetGroupRows.map((r) => ({
    id: String(r.assetGroup?.id), name: r.assetGroup?.name, campaignId: String(r.campaign?.id), status: r.assetGroup?.status,
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    today,
    purchaseAction: purchaseAction ?? null,
    spendToday: pesos(todayRaw.costMicros),
    month: { spend: pesos(monthRaw.costMicros), purchases: Math.round(monthRaw.purchases * 100) / 100, purchaseValue: Math.round(monthRaw.purchaseValue) },
    campaigns, adGroups, keywords, searchTerms, assetGroups,
  };
}
