import { describe, it, expect, beforeEach } from 'vitest';
import { fakeGoogleAds, PURCHASE_ACTION } from './helpers/gadsFakes.js';
import { listConversionActions, resolvePurchaseAction } from '../src/gads/purchaseAction.js';
import { buildGoogleSnapshot } from '../src/gads/snapshot.js';
import { buildGoogleBaseline } from '../src/gads/baseline.js';

const NOW = new Date('2026-10-21T15:00:00Z');

describe('foto de la cuenta de Google', () => {
  let gads;
  const purchaseAction = { resourceName: PURCHASE_ACTION, name: 'ALTORANCHO - GA4 (web) purchase', auto: true };
  beforeEach(() => { gads = fakeGoogleAds(); });

  it('lista las acciones de conversión activas', async () => {
    const list = await listConversionActions(gads);
    expect(list).toHaveLength(3);
    expect(list.find((a) => a.resourceName === PURCHASE_ACTION)).toEqual({ resourceName: PURCHASE_ACTION, name: 'ALTORANCHO - GA4 (web) purchase', category: 'PURCHASE', primary: true });
  });

  it('elige la compra primaria y la puede pisar el ajuste', async () => {
    expect(await resolvePurchaseAction(gads, {})).toMatchObject({ name: 'ALTORANCHO - GA4 (web) purchase', auto: true });
    expect(await resolvePurchaseAction(gads, { purchase_action: 'customers/8132886784/conversionActions/2' })).toMatchObject({ auto: false });
    expect(await resolvePurchaseAction(gads, { purchase_action: 'customers/8132886784/conversionActions/2' })).not.toHaveProperty('overrideMissing');
    expect(await resolvePurchaseAction(gads, { purchase_action: '2' })).toMatchObject({ resourceName: 'customers/8132886784/conversionActions/2', name: 'Compra (Tag de Google)', auto: false });
  });

  it('un ajuste que apunta a una acción inexistente vuelve a la elección automática y lo avisa', async () => {
    expect(await resolvePurchaseAction(gads, { purchase_action: 'customers/8132886784/conversionActions/999' })).toEqual({
      resourceName: PURCHASE_ACTION, name: 'ALTORANCHO - GA4 (web) purchase', auto: true, overrideMissing: true,
    });
  });

  it('sin compra primaria toma la primera de compra; sin ninguna, null', async () => {
    const noPrimary = { ...gads, search: async () => [
      { conversionAction: { resourceName: 'x/1', name: 'Vista', category: 'PAGE_VIEW', primaryForGoal: true, status: 'ENABLED' } },
      { conversionAction: { resourceName: 'x/2', name: 'Compra B', category: 'PURCHASE', primaryForGoal: false, status: 'ENABLED' } },
    ] };
    expect(await resolvePurchaseAction(noPrimary, {})).toEqual({ resourceName: 'x/2', name: 'Compra B', auto: true });
    const none = { ...gads, search: async () => [{ conversionAction: { resourceName: 'x/1', name: 'Vista', category: 'PAGE_VIEW', primaryForGoal: true, status: 'ENABLED' } }] };
    expect(await resolvePurchaseAction(none, {})).toBeNull();
  });

  it('Demand Gen con objetivo de visitas no se lee como ventas y las compras salen solo de la acción de compra', async () => {
    const s = await buildGoogleSnapshot({ gads, purchaseAction, now: NOW });
    expect(s.campaigns.find((c) => c.channelType === 'DEMAND_GEN')).toMatchObject({ family: 'traffic' });
    expect(s.campaigns.find((c) => c.name === 'altorancho_pmax_genérica_aon').platform7d).toMatchObject({ purchases: 69 });
    expect(s.keywords[0].id).toMatch(/^\d+~\d+$/);
    expect(gads.searchCount).toBeLessThanOrEqual(12);
  });

  it('arma campañas, grupos, palabras clave, términos y grupos de recursos', async () => {
    const s = await buildGoogleSnapshot({ gads, purchaseAction, now: NOW });
    expect(s.today).toBe('2026-10-21');
    expect(s.purchaseAction).toEqual(purchaseAction);
    // Incluye los 5000 de hoy de la campaña eliminada 104 (que no figura en la lista de campañas)
    expect(s.spendToday).toBe(77000);
    expect(s.campaigns.map((c) => c.id)).not.toContain('104');
    // El mes incluye todas las filas del fake (hoy, hoy-6, hoy-7, hoy-8) y la eliminada
    expect(s.month).toEqual({ spend: 142000, purchases: 114, purchaseValue: 8820000 });

    const pmax = s.campaigns.find((c) => c.id === '102');
    expect(pmax).toMatchObject({
      status: 'ENABLED', channelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
      targetRoas: 4.5, budgetId: '502', dailyBudgetArs: 60000, family: 'sales',
    });
    expect(pmax.platform7d).toEqual({ spend: 50000, purchases: 69, purchaseValue: 5400000, roas: 108, cpa: 725 });
    expect(pmax.platformPrev7d).toMatchObject({ spend: 45000, purchases: 40 });
    const dg = s.campaigns.find((c) => c.id === '103');
    // hoy-6 (1000 / 100 clics) cae en la semana actual; hoy-7 (2000 / 200 clics) en la anterior
    expect(dg.platform7d).toEqual({ spend: 9000, clicks: 1000, ctr: 1.67, cpc: 9, landingPageViews: 0, costPerLandingPageView: null });
    expect(dg.platformPrev7d).toMatchObject({ spend: 9000, clicks: 900 });
    expect(s.campaigns.find((c) => c.id === '101').targetRoas).toBeNull();

    expect(s.adGroups).toHaveLength(2);
    expect(s.adGroups.find((g) => g.id === '202')).toMatchObject({ campaignId: '103', family: 'traffic' });
    expect(s.adGroups.find((g) => g.id === '201').platform7d).toMatchObject({ spend: 14000, purchases: 3 });

    // 303 está pausada y sin costo en 14 días → afuera; 302 pausada pero gastó la semana anterior → adentro
    expect(s.keywords.map((k) => k.id)).toEqual(['201~301', '201~302']);
    expect(s.keywords[0]).toMatchObject({ text: 'mantas de lana', matchType: 'EXACT', adGroupId: '201', campaignId: '101', status: 'ENABLED' });
    expect(s.keywords[0].platform7d).toMatchObject({ spend: 12000, purchases: 3 });
    expect(s.keywords[1].platform7d).toMatchObject({ spend: 0, purchases: 0 });

    // 'mantas de lana' tiene compras → no figura
    expect(s.searchTerms).toEqual([
      { term: 'manta lana precio', campaignId: '101', adGroupId: '201', spend: 3000, clicks: 60 },
      { term: 'manta polar barata', campaignId: '101', adGroupId: '201', spend: 1500, clicks: 40 },
    ]);
    expect(s.assetGroups).toEqual([{ id: '401', name: 'genérica', campaignId: '102', status: 'ENABLED' }]);
  });

  it('las queries usan la acción de compra, ventanas de fechas argentinas y excluyen lo eliminado', async () => {
    await buildGoogleSnapshot({ gads, purchaseAction, now: NOW });
    const segmented = gads.queries.filter((q) => q.includes('segments.conversion_action'));
    expect(segmented.length).toBe(4);
    for (const q of segmented) {
      expect(q).toContain(`segments.conversion_action = '${PURCHASE_ACTION}'`);
      expect(q).toContain('metrics.all_conversions');
    }
    expect(gads.queries.join('\n')).not.toMatch(/metrics\.conversions\b/);
    expect(gads.queries.find((q) => /FROM campaign/.test(q) && q.includes('metrics.cost_micros'))).toContain("BETWEEN '2026-10-01' AND '2026-10-21'");
    expect(gads.queries.find((q) => /FROM ad_group\b/.test(q) && q.includes('metrics.cost_micros'))).toContain("BETWEEN '2026-10-15' AND '2026-10-21'");
    expect(gads.queries.find((q) => /FROM search_term_view/.test(q))).toContain("BETWEEN '2026-10-08' AND '2026-10-21'");
    // Estado filtrado solo en las queries de estructura; las de métricas incluyen lo eliminado
    const structure = gads.queries.filter((q) => !q.includes('metrics.') && !/FROM conversion_action/.test(q));
    expect(structure).toHaveLength(4);
    for (const q of structure) expect(q).toContain("!= 'REMOVED'");
    for (const q of gads.queries.filter((x) => /FROM campaign/.test(x) && x.includes('metrics.'))) expect(q).not.toContain('REMOVED');
  });

  it('sin acción de compra no hay compras y no se piden queries segmentadas', async () => {
    const s = await buildGoogleSnapshot({ gads, purchaseAction: null, now: NOW });
    expect(s.purchaseAction).toBeNull();
    expect(s.campaigns.find((c) => c.id === '102').platform7d).toMatchObject({ purchases: 0, purchaseValue: 0 });
    expect(s.month.purchases).toBe(0);
    expect(gads.queries.some((q) => q.includes('segments.conversion_action'))).toBe(false);
    expect(s.searchTerms).toHaveLength(3);
  });

  it('la línea de base suma 30 días por familia con la misma forma que la de Meta', async () => {
    const b = await buildGoogleBaseline({ gads, purchaseAction, now: NOW });
    expect(b.period).toEqual({ from: '2026-09-22', to: '2026-10-21' });
    expect(gads.searchCount).toBe(2);
    expect(b.campaigns.map((c) => c.id)).toEqual(['102', '101', '103', '104']);
    for (const q of gads.queries) expect(q).not.toContain('REMOVED');
    expect(b.campaigns[0]).toEqual({ id: '102', name: 'altorancho_pmax_genérica_aon', family: 'sales', metrics: { spend: 95000, purchases: 109, purchaseValue: 8400000, roas: 88.4, cpa: 872 } });
    // La eliminada 104 (5000) suma en ventas, igual que en la línea de base de Meta
    expect(b.account.sales).toMatchObject({ spend: 124000, purchases: 114, purchaseValue: 8820000 });
    expect(b.account.traffic).toMatchObject({ spend: 18000, clicks: 1900 });
    expect(Object.keys(b.account).sort()).toEqual(['sales', 'traffic']);
  });
});
