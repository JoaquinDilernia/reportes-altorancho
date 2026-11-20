// Familias de campaña por objetivo: cada una se mide con sus propias métricas (no todo es ROAS).
export const FAMILIES = ['sales', 'traffic', 'awareness', 'engagement'];

const META = {
  OUTCOME_SALES: 'sales', CONVERSIONS: 'sales', PRODUCT_CATALOG_SALES: 'sales',
  OUTCOME_TRAFFIC: 'traffic', LINK_CLICKS: 'traffic',
  OUTCOME_AWARENESS: 'awareness', REACH: 'awareness', BRAND_AWARENESS: 'awareness',
  OUTCOME_ENGAGEMENT: 'engagement', POST_ENGAGEMENT: 'engagement', VIDEO_VIEWS: 'engagement',
  OUTCOME_LEADS: 'engagement', OUTCOME_APP_PROMOTION: 'engagement',
};
// Desconocido → engagement: nunca se auto-pausa
export const metaFamily = (objective) => (Object.hasOwn(META, objective) ? META[objective] : 'engagement');

const GOOGLE = {
  MAXIMIZE_CONVERSION_VALUE: 'sales', TARGET_ROAS: 'sales', MAXIMIZE_CONVERSIONS: 'sales', TARGET_CPA: 'sales',
  MAXIMIZE_CLICKS: 'traffic', TARGET_SPEND: 'traffic', MANUAL_CPC: 'traffic', TARGET_IMPRESSION_SHARE: 'traffic',
  TARGET_CPM: 'awareness', TARGET_CPV: 'awareness', MANUAL_CPM: 'awareness',
};
export const googleFamily = ({ biddingStrategyType } = {}) => (Object.hasOwn(GOOGLE, biddingStrategyType) ? GOOGLE[biddingStrategyType] : 'engagement');

const n = (v) => (v == null || v === '' ? 0 : Number(v));
// a/b redondeado a `d` decimales; dividir por 0 → null
const div = (a, b, d = 0, k = 1) => (b ? Math.round((a / b) * k * 10 ** d) / 10 ** d : null);

// Solo los campos que importan para la familia
export function familyMetrics(family, m = {}) {
  const spend = n(m.spend);
  switch (family) {
    case 'sales': {
      const purchases = n(m.purchases);
      const purchaseValue = n(m.purchaseValue);
      return { spend, purchases, purchaseValue, roas: div(purchaseValue, spend, 1), cpa: div(spend, purchases) };
    }
    case 'traffic': {
      const clicks = n(m.clicks);
      const landingPageViews = n(m.landingPageViews);
      return {
        spend, clicks, ctr: div(clicks, n(m.impressions), 2, 100), cpc: div(spend, clicks),
        landingPageViews, costPerLandingPageView: div(spend, landingPageViews),
      };
    }
    case 'awareness': {
      const impressions = n(m.impressions);
      const reach = n(m.reach);
      return { spend, reach, impressions, cpm: div(spend, impressions, 0, 1000), frequency: div(impressions, reach, 2) };
    }
    default: {
      const engagements = n(m.engagements);
      return { spend, engagements, thruplays: n(m.thruplays), costPerEngagement: div(spend, engagements) };
    }
  }
}
