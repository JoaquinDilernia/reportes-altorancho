import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { requireAuth, generateToken } from './auth.mjs';
import { getProductBySku, getProductsBySku, querySalesByRange } from './firestore.mjs';
import { buildFullReport, ALL_CHANNELS } from './report.mjs';
import { getResumen } from './resumenReport.mjs';
import { getProducto } from './productoReport.mjs';
import { getWeb } from './webReport.mjs';
import { getLocales } from './localesReport.mjs';
import { getPauta } from './pautaReport.mjs';
import { getMayorista } from './mayoristaReport.mjs';
import { searchProducts, productSheet } from './productLookup.mjs';
import { getOriginBySku } from './productOrigin.mjs';
import { getPeriodRanges } from './periods.mjs';
import { getEventReport } from './eventReport.mjs';
import { getBehaviorReport } from './eventBehavior.mjs';
import { getClarityReport } from './clarity.mjs';
import { takeDailySnapshots } from './snapshots.mjs';
import { EVENTS, liveSyncEvent, argDay } from './events.mjs';
import { fetchProductImage } from './odoo.mjs';
import { fetchAdThumbnail } from './meta.mjs';
import posRoutes from './posRoutes.mjs';
import { seedSuperadminIfNeeded } from './posAuth.mjs';
import { seedPosConfigIfNeeded } from './posConfig.mjs';
import { startPosAutoRetry } from './posConfirm.mjs';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncPosLocales } from './sync/posLocales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
import { syncFeria } from './sync/feria.mjs';
import { syncMetaAds } from './sync/metaAds.mjs';
import { syncGoogleAds } from './sync/googleAds.mjs';
import { syncInflation } from './sync/inflation.mjs';
import { analyzeReport, chatAboutReport } from './insights.mjs';

export const app = express();
// Railway pone un proxy delante: confiar solo en 1 salto (no true) para que X-Forwarded-For no se falsee.
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
// La app de la feria (/api/feria) está apagada: el código sigue en feria*.mjs para la próxima feria.
app.use('/api/pos', posRoutes);

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

function parseReportParams(query) {
  const { period = 'week', date, start, end, channels } = query;
  if (period === 'custom') {
    if (!start || !end) return { error: 'Missing start/end' };
  } else if (!date) {
    return { error: 'Missing date' };
  }
  return { params: { period, date, start, end, channels: channels ? channels.split(',') : undefined } };
}

app.get('/api/report', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });

    const report = await buildFullReport(params);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[server] report error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cyber / Black: this year's event day by day vs. last year, with targets.
app.get('/api/event', requireAuth, async (req, res) => {
  try {
    const eventId = req.query.event || 'cyber';
    if (!EVENTS[eventId]) return res.status(400).json({ ok: false, error: `Unknown event: ${eventId}` });
    const report = await getEventReport(eventId);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[server] event report error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cyber / Black web behaviour from GA4 (funnel, sources, categories viewed,
// searches…). Separate from /api/event so the 5-min live poll doesn't hit GA4.
app.get('/api/event/behavior', requireAuth, async (req, res) => {
  try {
    const eventId = req.query.event || 'cyber';
    if (!EVENTS[eventId]) return res.status(400).json({ ok: false, error: `Unknown event: ${eventId}` });
    res.json({ ok: true, ...(await getBehaviorReport(eventId)) });
  } catch (err) {
    console.error('[server] event behavior error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Clarity behaviour signals (rage/dead clicks, scroll) for the last 24 h.
app.get('/api/clarity', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await getClarityReport()) });
  } catch (err) {
    console.error('[server] clarity error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// New report (/?v=nuevo). Same period params as /api/report.
app.get('/api/v2/resumen', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getResumen(params)) });
  } catch (err) {
    console.error('[server] v2 resumen error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/mayorista', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getMayorista(params)) });
  } catch (err) {
    console.error('[server] v2 mayorista error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/pauta', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getPauta(params)) });
  } catch (err) {
    console.error('[server] v2 pauta error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/locales', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getLocales(params)) });
  } catch (err) {
    console.error('[server] v2 locales error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/web', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getWeb(params)) });
  } catch (err) {
    console.error('[server] v2 web error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/producto', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getProducto({ ...params, ch: String(req.query.ch || 'all') })) });
  } catch (err) {
    console.error('[server] v2 producto error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/product-search', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, results: searchProducts(await getProductsBySku(), String(req.query.q || '')) });
  } catch (err) {
    console.error('[server] v2 product-search error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v2/product/:sku', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    const { current } = params.period === 'custom'
      ? getPeriodRanges(params.start, 'custom', params.end)
      : getPeriodRanges(params.date, params.period);
    const [productsBySku, salesDocs, originBySku] = await Promise.all([
      getProductsBySku(),
      querySalesByRange(ALL_CHANNELS, current.start, current.end),
      getOriginBySku().catch(() => new Map()),
    ]);
    const sheet = productSheet({ sku: req.params.sku, productsBySku, salesDocs, originBySku });
    if (!sheet) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    res.json({ ok: true, range: current, ...sheet });
  } catch (err) {
    console.error('[server] v2 product error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI insights — both endpoints require the same login as /api/report (they
// expose the same business data, just narrated instead of tabulated).
app.post('/api/insights/analyze', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const text = await analyzeReport(params);
    res.json({ ok: true, text });
  } catch (err) {
    console.error('[server] insights/analyze error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/insights/chat', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.body);
    if (error) return res.status(400).json({ ok: false, error });
    if (!Array.isArray(req.body.messages) || req.body.messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'Missing messages' });
    }

    const report = await buildFullReport(params);
    const text = await chatAboutReport({ report, messages: req.body.messages });
    res.json({ ok: true, text });
  } catch (err) {
    console.error('[server] insights/chat error:', err);
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
    if (!/^\d+$/.test(req.params.adId)) return res.status(400).end();

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

const PORT = process.env.PORT || 3000;

const SYNC_HOURS = parseInt(process.env.SYNC_INTERVAL_HOURS || '4', 10);
let syncRunning = false;
let categoryBySkuCache = null;

// Set by the full sync; before the first one finishes (fresh boot) it is
// rebuilt once from the products already stored in Firestore.
async function getCategoryBySku() {
  if (categoryBySkuCache) return categoryBySkuCache;
  const products = await getProductsBySku();
  categoryBySkuCache = new Map([...products.values()].map(p => [p.sku, p.category]));
  return categoryBySkuCache;
}

async function runFullSync() {
  if (syncRunning) { console.log('[cron] sync already running, skipping'); return; }
  syncRunning = true;
  try {
    const { categoryBySku } = await syncProducts();
    categoryBySkuCache = categoryBySku;
    await syncEcommerce(categoryBySku);
    await syncLocales(categoryBySku);
    try {
      await syncPosLocales(categoryBySku);
    } catch (err) {
      console.error('[cron] posLocales sync error:', err.message);
    }
    await syncMayorista(categoryBySku);
    try {
      // The one-time full feria re-read is heavier; if it fails, ads and
      // inflation still sync and the next run retries it.
      await syncFeria(categoryBySku);
    } catch (err) {
      console.error('[cron] feria sync error:', err.message);
    }
    await syncMetaAds();
    try {
      await syncGoogleAds();
    } catch (err) {
      console.error('[cron] googleAds sync error:', err.message);
    }
    await syncInflation();
    console.log('[cron] full sync complete');
  } catch (err) {
    console.error('[cron] sync error:', err.message);
  } finally {
    syncRunning = false;
  }
}

// While an event is running, sales and ads refresh far more often than the
// 4-hourly full sync so the live tab is current.
const LIVE_SYNC_MINUTES = parseInt(process.env.LIVE_SYNC_MINUTES || '5', 10);
const eventIsActive = () => !!liveSyncEvent(argDay(new Date().toISOString()));
const LIVE_ADS_EVERY_MS = 30 * 60 * 1000;
let lastLiveAdsSyncAt = 0;

async function runLive(name, steps) {
  if (!eventIsActive()) return;
  if (syncRunning) { console.log(`[cron:live] ${name}: sync already running, skipping`); return; }
  syncRunning = true;
  try {
    for (const [label, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        console.error(`[cron:live] ${label} error:`, err.message);
      }
    }
  } finally {
    syncRunning = false;
  }
}

async function runLiveSalesSync() {
  await runLive('ventas', [
    ['ecommerce', async () => syncEcommerce(await getCategoryBySku())],
    ['locales', async () => syncLocales(await getCategoryBySku())],
    ['posLocales', async () => syncPosLocales(await getCategoryBySku())],
    // Ads ride along in this job (at most every 30 min) instead of having
    // their own cron: both would fire on the same second and the second one
    // would always find the shared lock taken.
    ['ads', async () => {
      if (Date.now() - lastLiveAdsSyncAt < LIVE_ADS_EVERY_MS) return;
      lastLiveAdsSyncAt = Date.now();
      try { await syncMetaAds({ daysBack: 2, includeAdLevel: false }); } catch (err) { console.error('[cron:live] metaAds error:', err.message); }
      try { await syncGoogleAds({ daysBack: 2 }); } catch (err) { console.error('[cron:live] googleAds error:', err.message); }
    }],
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Crons only when run as the server: importing { app } from a script must never sync.
  cron.schedule(`0 */${SYNC_HOURS} * * *`, runFullSync);
  console.log(`[server] cron scheduled every ${SYNC_HOURS}h`);
  // Offset to minute 2 so it never fires in the same second as the `0 */N` full sync.
  cron.schedule(`2-59/${LIVE_SYNC_MINUTES} * * * *`, runLiveSalesSync);
  // Daily snapshots (Clarity, web stock): 00:05 ART, retried at 06:00 and
  // 12:00 only if the day is still missing (each run checks first).
  for (const expr of ['5 0 * * *', '0 6 * * *', '0 12 * * *']) {
    cron.schedule(expr, () => takeDailySnapshots(), { timezone: 'America/Argentina/Buenos_Aires' });
  }
  startPosAutoRetry();
  seedPosConfigIfNeeded().catch(err => console.error('[pos] Error cargando configuración inicial:', err.message));
  seedSuperadminIfNeeded().catch(err => console.error('[pos] Error creando superadmin:', err.message));
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}
