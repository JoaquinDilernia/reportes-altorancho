import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getProductsBySku, queryMetaAdsDailyByRange, queryMetaAdsAdDailyByRange } from './firestore.mjs';
import {
  computeTotals, computeTopProducts, computeCategoryBreakdown,
  computePaymentMethods, computeProvinces, computeDelta, computeDailyBreakdown,
  computeDailyBreakdownByChannel,
} from './aggregate.mjs';
import { computeAdTotals, computeAdDailyBreakdown, computeTopAds } from './aggregateAds.mjs';

export const ALL_CHANNELS = ['ecommerce', 'local_lomas', 'local_belgrano', 'local_alcorta', 'mayorista'];

export async function buildTotalsSection(channels, range, productsBySku) {
  const sales = await querySalesByRange(channels, range.start, range.end);
  return {
    totals: computeTotals(sales),
    dailyBreakdown: computeDailyBreakdown(sales),
    dailyBreakdownByChannel: computeDailyBreakdownByChannel(sales, channels),
    topProductsByUnits: computeTopProducts(sales, productsBySku, { by: 'units', limit: 10 }),
    topProductsByRevenue: computeTopProducts(sales, productsBySku, { by: 'revenue', limit: 10 }),
    categories: computeCategoryBreakdown(sales),
    paymentMethods: computePaymentMethods(sales),
    provinces: computeProvinces(sales),
  };
}

export async function buildAdsSection(range) {
  try {
    const [dailyRows, adDailyRows] = await Promise.all([
      queryMetaAdsDailyByRange(range.start, range.end),
      queryMetaAdsAdDailyByRange(range.start, range.end),
    ]);
    return {
      totals: computeAdTotals(dailyRows),
      dailyBreakdown: computeAdDailyBreakdown(dailyRows),
      // Higher than the ~10 the UI shows at once: the frontend re-sorts this
      // same list into "más gasto"/"mejores"/"peores" tabs client-side, so it
      // needs enough ads to make each ranking meaningful, not just the top
      // spenders.
      topAds: computeTopAds(adDailyRows, { limit: 50 }),
    };
  } catch (err) {
    console.error('[server] metaAds section error:', err.message);
    return { totals: computeAdTotals([]), dailyBreakdown: [], topAds: [] };
  }
}

export function diffTotals(current, previous) {
  return {
    revenue: computeDelta(current.revenue, previous.revenue),
    shippingRevenue: computeDelta(current.shippingRevenue, previous.shippingRevenue),
    units: computeDelta(current.units, previous.units),
    orders: computeDelta(current.orders, previous.orders),
    avgTicket: computeDelta(current.avgTicket, previous.avgTicket),
    avgDailyRevenue: computeDelta(current.avgDailyRevenue, previous.avgDailyRevenue),
    cancellationRate: computeDelta(current.cancellationRate, previous.cancellationRate),
    amountCollected: computeDelta(current.amountCollected, previous.amountCollected),
    collectionRate: computeDelta(current.collectionRate, previous.collectionRate),
  };
}

export function diffAdTotals(current, previous) {
  return {
    spend: computeDelta(current.spend, previous.spend),
    impressions: computeDelta(current.impressions, previous.impressions),
    reach: computeDelta(current.reach, previous.reach),
    clicks: computeDelta(current.clicks, previous.clicks),
    ctr: computeDelta(current.ctr, previous.ctr),
    cpc: computeDelta(current.cpc, previous.cpc),
    purchases: computeDelta(current.purchases, previous.purchases),
    purchaseValue: computeDelta(current.purchaseValue, previous.purchaseValue),
    roas: computeDelta(current.roas, previous.roas),
    addToCart: computeDelta(current.addToCart, previous.addToCart),
    initiateCheckout: computeDelta(current.initiateCheckout, previous.initiateCheckout),
    landingPageViews: computeDelta(current.landingPageViews, previous.landingPageViews),
    costPerPurchase: computeDelta(current.costPerPurchase, previous.costPerPurchase),
    costPerAddToCart: computeDelta(current.costPerAddToCart, previous.costPerAddToCart),
  };
}

// Builds the exact payload GET /api/report returns, given already-parsed
// query params. Shared by the report endpoint and the AI insights tool so
// both read the business through the same lens.
export async function buildFullReport({ period = 'week', date, start, end, channels }) {
  const requestedChannels = channels && channels.length ? channels : ALL_CHANNELS;
  const ranges = period === 'custom' ? getPeriodRanges(start, period, end) : getPeriodRanges(date, period);
  const productsBySku = await getProductsBySku();

  const [current, prevPeriod, prevMonth, prevYear, currentAds, prevPeriodAds, prevMonthAds, prevYearAds] = await Promise.all([
    buildTotalsSection(requestedChannels, ranges.current, productsBySku),
    buildTotalsSection(requestedChannels, ranges.prevPeriod, productsBySku),
    buildTotalsSection(requestedChannels, ranges.prevMonth, productsBySku),
    buildTotalsSection(requestedChannels, ranges.prevYear, productsBySku),
    buildAdsSection(ranges.current),
    buildAdsSection(ranges.prevPeriod),
    buildAdsSection(ranges.prevMonth),
    buildAdsSection(ranges.prevYear),
  ]);

  return {
    range: ranges.current,
    current: { ...current, metaAds: currentAds },
    comparisons: {
      prevPeriod: {
        range: ranges.prevPeriod, totals: prevPeriod.totals, deltas: diffTotals(current.totals, prevPeriod.totals),
        metaAdsDeltas: diffAdTotals(currentAds.totals, prevPeriodAds.totals),
      },
      prevMonth: {
        range: ranges.prevMonth, totals: prevMonth.totals, deltas: diffTotals(current.totals, prevMonth.totals),
        metaAdsDeltas: diffAdTotals(currentAds.totals, prevMonthAds.totals),
      },
      prevYear: {
        range: ranges.prevYear, totals: prevYear.totals, deltas: diffTotals(current.totals, prevYear.totals),
        metaAdsDeltas: diffAdTotals(currentAds.totals, prevYearAds.totals),
      },
    },
  };
}
