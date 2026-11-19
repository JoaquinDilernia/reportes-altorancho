import { artDate, addDays } from '../engine/dates.js';
import { googleFamily } from '../ads/families.js';
import { lit, between, emptyRaw, addMetrics, addPurchases, toFamilyMetrics } from './snapshot.js';
import { resolvePurchaseAction } from './purchaseAction.js';

// Foto de los últimos 30 días de la cuenta de Google, por campaña y por familia (misma forma que la de Meta).
// En la cuenta se suman las métricas crudas por familia y recién después se calculan los ratios.
export async function buildGoogleBaseline({ gads, purchaseAction, now = new Date() }) {
  const to = artDate(now);
  const from = addDays(to, -29);
  // Incluye campañas eliminadas: su gasto del período cuenta igual que en la línea de base de Meta
  const where = between(from, to);
  const [rows, purchaseRows] = await Promise.all([
    gads.search(`SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type,
  metrics.cost_micros, metrics.clicks, metrics.impressions
FROM campaign
WHERE ${where}`),
    purchaseAction?.resourceName
      ? gads.search(`SELECT campaign.id, segments.conversion_action, metrics.all_conversions, metrics.all_conversions_value
FROM campaign
WHERE ${where} AND segments.conversion_action = ${lit(purchaseAction.resourceName)}`)
      : Promise.resolve([]),
  ]);

  const byId = new Map();
  for (const r of rows) {
    const c = r.campaign || {};
    const id = String(c.id);
    const e = byId.get(id) || { id, name: c.name ?? null, family: googleFamily({ advertisingChannelType: c.advertisingChannelType, biddingStrategyType: c.biddingStrategyType }), raw: emptyRaw() };
    addMetrics(e.raw, r.metrics);
    byId.set(id, e);
  }
  for (const r of purchaseRows) {
    const e = byId.get(String(r.campaign?.id));
    if (e) addPurchases(e.raw, r.metrics);
  }

  const sums = {};
  const active = [...byId.values()].filter((e) => e.raw.costMicros || e.raw.clicks || e.raw.impressions || e.raw.purchases);
  const campaigns = active.map((e) => {
    sums[e.family] ??= emptyRaw();
    const s = sums[e.family];
    for (const k of Object.keys(s)) s[k] += e.raw[k];
    return { id: e.id, name: e.name, family: e.family, metrics: toFamilyMetrics(e.family, e.raw) };
  });
  campaigns.sort((a, b) => b.metrics.spend - a.metrics.spend);
  const account = Object.fromEntries(Object.entries(sums).map(([family, raw]) => [family, toFamilyMetrics(family, raw)]));
  return { period: { from, to }, account, campaigns };
}

// Toma la foto con la acción de compra de los ajustes y la guarda en el repo de Google
export function createGoogleBaselineTaker({ gads, repo }) {
  return async (reason) => {
    const purchaseAction = await resolvePurchaseAction(gads, await repo.getSettings());
    return repo.addBaseline({ reason, data: { ...await buildGoogleBaseline({ gads, purchaseAction }), purchaseAction } });
  };
}
