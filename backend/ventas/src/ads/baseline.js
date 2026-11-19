import { artDate, addDays } from '../engine/dates.js';
import { metaFamily, familyMetrics } from './families.js';
import { summarizeMetaRow } from './metrics.js';

// Métricas crudas (sumables) de una fila de insights de Meta
const RAW = ['spend', 'impressions', 'reach', 'clicks', 'landingPageViews', 'engagements', 'thruplays', 'purchases', 'purchaseValue'];
function rawMetrics(row) {
  const s = summarizeMetaRow(row);
  return {
    spend: s.spend, impressions: s.impressions, reach: s.reach, clicks: s.clicks, landingPageViews: s.landingPageViews,
    engagements: s.engagements, thruplays: s.thruplays, purchases: s.metaPurchases, purchaseValue: s.metaValue,
  };
}

// Foto de los últimos 30 días de la cuenta de Meta, por campaña y por familia, para comparar el antes y el después del agente.
// En la cuenta se suman las métricas crudas por familia y recién después se calculan los ratios (ROAS, CPA, CTR…).
export async function buildMetaBaseline({ meta, now = new Date() }) {
  const to = artDate(now);
  const from = addDays(to, -29);
  const [rows, listed] = await Promise.all([meta.getInsights('campaign', from, to), meta.getCampaigns()]);
  const byId = new Map(listed.map((c) => [c.id, c]));
  const missing = [...new Set(rows.map((r) => r.campaign_id))].filter((id) => id && !byId.has(id));
  if (missing.length) for (const c of await meta.getByIds('campaign', missing)) byId.set(c.id, c);

  const sums = {};
  const campaigns = rows.filter((r) => r.campaign_id).map((r) => {
    const c = byId.get(r.campaign_id);
    const family = metaFamily(c?.objective);
    const raw = rawMetrics(r);
    sums[family] ??= Object.fromEntries(RAW.map((k) => [k, 0]));
    for (const k of RAW) sums[family][k] += raw[k];
    return { id: r.campaign_id, name: c?.name ?? null, family, metrics: familyMetrics(family, raw) };
  });
  campaigns.sort((a, b) => b.metrics.spend - a.metrics.spend);
  const account = Object.fromEntries(Object.entries(sums).map(([family, m]) => [family, familyMetrics(family, m)]));
  return { period: { from, to }, account, campaigns };
}

// Toma la foto y la guarda en el repo de la plataforma
export function createMetaBaselineTaker({ meta, repo }) {
  return async (reason) => repo.addBaseline({ reason, data: await buildMetaBaseline({ meta }) });
}
