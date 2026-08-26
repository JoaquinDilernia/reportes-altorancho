import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { requireAuth, generateToken } from './auth.mjs';
import { getProductBySku } from './firestore.mjs';
import { buildFullReport } from './report.mjs';
import { fetchProductImage } from './odoo.mjs';
import { fetchAdThumbnail } from './meta.mjs';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
import { syncFeria } from './sync/feria.mjs';
import { syncMetaAds } from './sync/metaAds.mjs';
import { syncInflation } from './sync/inflation.mjs';
import { analyzeReport, chatAboutReport } from './insights.mjs';

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

async function runFullSync() {
  if (syncRunning) { console.log('[cron] sync already running, skipping'); return; }
  syncRunning = true;
  try {
    const { categoryBySku } = await syncProducts();
    await syncEcommerce(categoryBySku);
    await syncLocales(categoryBySku);
    await syncMayorista(categoryBySku);
    await syncFeria(categoryBySku);
    await syncMetaAds();
    await syncInflation();
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
