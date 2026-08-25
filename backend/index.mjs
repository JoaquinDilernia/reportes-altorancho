import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { requireAuth, generateToken } from './auth.mjs';
import { getPeriodRanges } from './periods.mjs';
import { querySalesByRange, getProductsBySku, getProductBySku, queryMetaAdsDailyByRange, queryMetaAdsAdDailyByRange } from './firestore.mjs';
import {
  computeTotals, computeTopProducts, computeCategoryBreakdown,
  computePaymentMethods, computeProvinces, computeDelta, computeDailyBreakdown,
  computeDailyBreakdownByChannel,
} from './aggregate.mjs';
import { computeAdTotals, computeAdDailyBreakdown, computeTopAds } from './aggregateAds.mjs';
import { fetchProductImage } from './odoo.mjs';
import { fetchAdThumbnail } from './meta.mjs';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
import { syncMetaAds } from './sync/metaAds.mjs';

export const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  res.json({ ok: true, token: generateToken() });
});

const ALL_CHANNELS = ['ecommerce', 'local_lomas', 'local_belgrano', 'local_alcorta', 'mayorista'];

async function buildTotalsSection(channels, range, productsBySku) {
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

async function buildAdsSection(range) {
  const [dailyRows, adDailyRows] = await Promise.all([
    queryMetaAdsDailyByRange(range.start, range.end),
    queryMetaAdsAdDailyByRange(range.start, range.end),
  ]);
  return {
    totals: computeAdTotals(dailyRows),
    dailyBreakdown: computeAdDailyBreakdown(dailyRows),
    topAds: computeTopAds(adDailyRows, { limit: 10 }),
  };
}

app.get('/api/report', requireAuth, async (req, res) => {
  try {
    const { period = 'week', date, start, end, channels } = req.query;

    if (period === 'custom') {
      if (!start || !end) return res.status(400).json({ ok: false, error: 'Missing start/end' });
    } else if (!date) {
      return res.status(400).json({ ok: false, error: 'Missing date' });
    }

    const requestedChannels = channels ? channels.split(',') : ALL_CHANNELS;
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

    res.json({
      ok: true,
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
    });
  } catch (err) {
    console.error('[server] report error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Not behind requireAuth: a plain <img src> can't send an Authorization
// header, and product photos aren't sensitive data (unlike the sales
// figures /api/report guards). Odoo itself requires an authenticated
// session to serve the real image (see fetchProductImage), so this still
// isn't reachable without the backend's own Odoo credentials.
app.get('/api/product-image/:sku', async (req, res) => {
  try {
    const product = await getProductBySku(req.params.sku);
    if (!product?.odooTemplateId) return res.status(404).end();

    const image = await fetchProductImage(product.odooTemplateId);
    if (!image) return res.status(404).end();

    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(image.buffer);
  } catch (err) {
    console.error('[server] product-image error:', err.message);
    res.status(500).end();
  }
});

// Not behind requireAuth — same reasoning as /api/product-image/:sku: a plain
// <img src> can't send an Authorization header, and creative thumbnails
// aren't sensitive. Meta's thumbnail_url is a signed URL that expires, so
// this re-resolves it live and proxies the bytes rather than redirecting
// (avoids exposing the ever-rotating signed URL to the browser).
app.get('/api/ad-image/:adId', async (req, res) => {
  try {
    const thumbnailUrl = await fetchAdThumbnail(req.params.adId);
    if (!thumbnailUrl) return res.status(404).end();

    const imageRes = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(15_000) });
    if (!imageRes.ok) return res.status(404).end();

    res.set('Content-Type', imageRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await imageRes.arrayBuffer()));
  } catch (err) {
    console.error('[server] ad-image error:', err.message);
    res.status(500).end();
  }
});

function diffTotals(current, previous) {
  return {
    revenue: computeDelta(current.revenue, previous.revenue),
    shippingRevenue: computeDelta(current.shippingRevenue, previous.shippingRevenue),
    units: computeDelta(current.units, previous.units),
    orders: computeDelta(current.orders, previous.orders),
    avgTicket: computeDelta(current.avgTicket, previous.avgTicket),
    avgDailyRevenue: computeDelta(current.avgDailyRevenue, previous.avgDailyRevenue),
    cancellationRate: computeDelta(current.cancellationRate, previous.cancellationRate),
  };
}

function diffAdTotals(current, previous) {
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
  };
}

const PORT = process.env.PORT || 3000;

const SYNC_HOURS = parseInt(process.env.SYNC_INTERVAL_HOURS || '4', 10);
let syncRunning = false;

async function runFullSync() {
  if (syncRunning) { console.log('[cron] sync already running, skipping'); return; }
  syncRunning = true;
  try {
    const { categoryBySku } = await syncProducts();
    await syncEcommerce(categoryBySku);
    await syncLocales(categoryBySku);
    await syncMayorista(categoryBySku);
    await syncMetaAds();
    console.log('[cron] full sync complete');
  } catch (err) {
    console.error('[cron] sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}

cron.schedule(`0 */${SYNC_HOURS} * * *`, runFullSync);
console.log(`[server] cron scheduled every ${SYNC_HOURS}h`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}
