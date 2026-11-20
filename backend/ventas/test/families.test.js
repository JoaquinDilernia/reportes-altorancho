import { describe, it, expect } from 'vitest';
import { metaFamily, googleFamily, familyMetrics, FAMILIES } from '../src/ads/families.js';
import { checkAutoPause } from '../src/ads/autoPause.js';
import { summarizeMetaRow } from '../src/ads/metrics.js';

describe('familias por objetivo', () => {
  it('Meta: objetivo → familia', () => {
    expect(FAMILIES).toEqual(['sales', 'traffic', 'awareness', 'engagement']);
    expect(metaFamily('OUTCOME_SALES')).toBe('sales');
    expect(metaFamily('OUTCOME_TRAFFIC')).toBe('traffic');
    expect(metaFamily('LINK_CLICKS')).toBe('traffic');
    expect(metaFamily('REACH')).toBe('awareness');
    expect(metaFamily('VIDEO_VIEWS')).toBe('engagement');
    expect(metaFamily('OUTCOME_LEADS')).toBe('engagement');
    expect(metaFamily('ALGO_NUEVO')).toBe('engagement');
    expect(metaFamily('constructor')).toBe('engagement');
    expect(metaFamily('CONVERSIONS')).toBe('sales');
    expect(metaFamily('PRODUCT_CATALOG_SALES')).toBe('sales');
  });
  it('Google: estrategia de puja → familia', () => {
    expect(googleFamily({ channelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE' })).toBe('sales');
    expect(googleFamily({ channelType: 'SEARCH', biddingStrategyType: 'TARGET_IMPRESSION_SHARE' })).toBe('traffic');
    expect(googleFamily({ channelType: 'DISPLAY', biddingStrategyType: 'TARGET_CPM' })).toBe('awareness');
    expect(googleFamily({ channelType: 'X', biddingStrategyType: 'OTRA' })).toBe('engagement');
  });
});

describe('familyMetrics', () => {
  it('ventas', () => {
    expect(familyMetrics('sales', { spend: 10000, purchases: 2, purchaseValue: 60000 })).toEqual({ spend: 10000, purchases: 2, purchaseValue: 60000, roas: 6, cpa: 5000 });
  });
  it('división por 0 → null', () => {
    expect(familyMetrics('traffic', { spend: 1000, clicks: 0, impressions: 0 })).toMatchObject({ ctr: null, cpc: null });
    expect(familyMetrics('sales', { spend: 0, purchaseValue: 5 })).toMatchObject({ roas: null, cpa: null });
  });
  it('tráfico, awareness y engagement', () => {
    expect(familyMetrics('traffic', { spend: 1000, clicks: 50, impressions: 2000, landingPageViews: 40 }))
      .toEqual({ spend: 1000, clicks: 50, ctr: 2.5, cpc: 20, landingPageViews: 40, costPerLandingPageView: 25 });
    expect(familyMetrics('awareness', { spend: 1000, reach: 1000, impressions: 2500 }))
      .toEqual({ spend: 1000, reach: 1000, impressions: 2500, cpm: 400, frequency: 2.5 });
    expect(familyMetrics('engagement', { spend: 1000, engagements: 20, thruplays: 5 }))
      .toEqual({ spend: 1000, engagements: 20, thruplays: 5, costPerEngagement: 50 });
  });
});

describe('summarizeMetaRow ampliado', () => {
  it('agrega clicks, reach, cpc, landing, engagements, thruplays', () => {
    const s = summarizeMetaRow({
      spend: '100', clicks: '10', reach: '500', cpc: '10.4',
      actions: [{ action_type: 'landing_page_view', value: '7' }, { action_type: 'post_engagement', value: '12' }, { action_type: 'video_view', value: '3' }],
    });
    expect(s).toMatchObject({ spend: 100, clicks: 10, reach: 500, cpc: 10, landingPageViews: 7, engagements: 12, thruplays: 3 });
    expect(summarizeMetaRow({ video_thruplay_watched_actions: [{ action_type: 'video_view', value: '9' }] }).thruplays).toBe(9);
  });
});

describe('checkAutoPause', () => {
  const s = { autonomous: true, auto_pause_min_spend_ars: 50000, auto_pause_days: 7 };
  it('falla cerrado con datos malos, default de días y objetivo desconocido', () => {
    expect(checkAutoPause({ settings: s, family: 'sales', spend: NaN, purchases: 0 }).ok).toBe(false);
    expect(checkAutoPause({ settings: s, family: 'sales', spend: 90000 }).ok).toBe(false);
    expect(checkAutoPause({ settings: s, family: 'sales', spend: 90000 }).reason).toMatch(/faltan datos/);
    const { auto_pause_days, ...sinDias } = s;
    expect(checkAutoPause({ settings: sinDias, family: 'sales', spend: 90000, purchases: 0 }).reason).toContain('7 días');
    expect(checkAutoPause({ settings: s, family: metaFamily('ALGO'), spend: 90000, purchases: 0 }).ok).toBe(false);
  });
  it('pausa solo ventas con gasto sobre el mínimo y sin compras', () => {
    expect(checkAutoPause({ settings: s, family: 'sales', spend: 60000, purchases: 0 })).toEqual({ ok: true, reason: expect.stringContaining('$60.000') });
    expect(checkAutoPause({ settings: s, family: 'sales', spend: 40000, purchases: 0 }).ok).toBe(false);
    expect(checkAutoPause({ settings: s, family: 'sales', spend: 90000, purchases: 1 }).ok).toBe(false);
    expect(checkAutoPause({ settings: s, family: 'traffic', spend: 90000, purchases: 0 }).ok).toBe(false);
    expect(checkAutoPause({ settings: { ...s, auto_pause_min_spend_ars: 0 }, family: 'sales', spend: 90000, purchases: 0 }).reason).toMatch(/mínimo/);
    expect(checkAutoPause({ settings: { ...s, autonomous: false }, family: 'sales', spend: 90000, purchases: 0 }).ok).toBe(false);
  });
});
