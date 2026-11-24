import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { requireAuth, requireAuthOrSecret, generateToken } from './auth.mjs';
import { getProductBySku, getProductsBySku, querySalesByRange } from './firestore.mjs';
import { buildFullReport, ALL_CHANNELS } from './report.mjs';
import { getResumen } from './resumenReport.mjs';
import { getProducto } from './productoReport.mjs';
import { getWeb } from './webReport.mjs';
import { getLocales } from './localesReport.mjs';
import { getLectores } from './lectoresReport.mjs';
import { getPauta } from './pautaReport.mjs';
import { getPautaReal, getPautaClientes, clearPautaRealCache } from './pautaRealReport.mjs';
import { getMarketingCosts, setMarketingCost } from './marketingCosts.mjs';
import { syncPinterestAds, getPinterestStatus, isPinterestConfigured } from './pinterestAds.mjs';
import ginezaProxy from './ginezaProxy.mjs';
import { useLocalGineza, fetchTrackingChannels, fetchTrackingInsights, fetchTrackingAlerts } from './gineza.mjs';
import { isPerfitConfigured, getPerfitSummary, snapshotAutomations } from './perfit.mjs';
import { isVentasConfigured, startVentas } from './ventas/module.mjs';
import { listVentas, getVenta, ventasRange } from './ventasReport.mjs';
import { getMayorista } from './mayoristaReport.mjs';
import { searchProducts, productSheet } from './productLookup.mjs';
import { getOriginBySku } from './productOrigin.mjs';
import { getPeriodRanges } from './periods.mjs';
import { getEventReport, getEventPulse } from './eventReport.mjs';
import { getBehaviorReport } from './eventBehavior.mjs';
import { getClarityReport, isClarityConfigured } from './clarity.mjs';
import { isGa4Configured } from './ga4.mjs';
import { takeDailySnapshots } from './snapshots.mjs';
import { EVENTS, liveSyncEvent, argDay } from './events.mjs';
import { fetchProductImage } from './odoo.mjs';
import { fetchAdThumbnail } from './meta.mjs';
import posRoutes from './posRoutes.mjs';
import { jsonExceptBigBodies } from './posWebReturnsRoutes.mjs';
import { seedSuperadminIfNeeded } from './posAuth.mjs';
import { seedPosConfigIfNeeded } from './posConfig.mjs';
import { startPosAutoRetry } from './posConfirm.mjs';
import { backgroundJobsEnabled, assertSafeDevEnv } from './runtimeFlags.mjs';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncPosLocales } from './sync/posLocales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
import { syncFeria } from './sync/feria.mjs';
import { syncCreditNotes } from './sync/creditNotes.mjs';
import { syncMetaAds } from './sync/metaAds.mjs';
import { syncGoogleAds } from './sync/googleAds.mjs';
import { syncInflation } from './sync/inflation.mjs';
import { analyzeReport, chatAboutReport } from './insights.mjs';
import { runPickSync, getPickSyncStatus, isPickSyncRunning } from './sync/pickPrices.mjs';

export const app = express();
// Railway pone un proxy delante: confiar solo en 1 salto (no true) para que X-Forwarded-For no se falsee.
app.set('trust proxy', 1);

// Recorrido de visitantes: script público de la tienda y adonde manda los eventos
app.use((req, res, next) => (ventas && (req.path === '/t.js' || req.path.startsWith('/t/')) ? ventas.trackRouter(req, res, next) : next()));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
// Agente y Ventas (lo que era gineza). Si el módulo corre en este servidor
// (VENTAS_DATABASE_URL o DATABASE_URL), lo atienden sus rutas; si no, el proxy
// a gineza. Todo antes de express.json(): el webhook de Tienda Nube firma el
// cuerpo crudo y las piezas del agente se suben como archivo.
const ventasApi = express.Router();
ventasApi.use(requireAuth, express.json({ limit: '2mb' }));
let ventas = null;
app.use('/api/gz', (req, res, next) => (ventas ? ventasApi : ginezaProxy)(req, res, next));
app.use('/webhooks', (req, res, next) => (ventas ? ventas.webhookRouter(req, res, next) : next()));
app.use('/ingest', (req, res, next) => (ventas ? ventas.ingestRouter(req, res, next) : next()));

// Lectores de precios (ex servicio pick-altorancho). El admin de los lectores
// manda PICK_SYNC_SECRET; el panel puede usar su token normal.
const requirePickAuth = requireAuthOrSecret('PICK_SYNC_SECRET');
app.post('/api/pick/sync', requirePickAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await runPickSync()) });
  } catch (err) {
    if (err.status !== 409) console.error('[pick] error de sync:', err.message);
    res.status(err.status || 500).json({ ok: false, error: err.status === 409 ? err.message : 'No se pudo sincronizar los precios' });
  }
});
app.get('/api/pick/status', requirePickAuth, async (req, res) => {
  try {
    res.json({ ok: true, running: isPickSyncRunning(), lastSync: await getPickSyncStatus() });
  } catch (err) {
    console.error('[pick] error de estado:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo leer el estado' });
  }
});

export async function mountVentas(v, { selfUrl, mintToken = () => generateToken(300) } = {}) {
  for (const r of v.apiRouters) ventasApi.use(r);
  ventasApi.use((_req, res) => res.status(404).json({ error: 'no encontrado' }));
  // eslint-disable-next-line no-unused-vars
  ventasApi.use((err, _req, res, _next) => {
    if (!err.status || err.status >= 500) console.error('[ventas] api:', err);
    res.status(err.status || 500).json({ error: err.message });
  });
  ventas = v;
  if (selfUrl) useLocalGineza({ apiRoot: `${selfUrl}/api/gz`, authHeader: () => `Bearer ${mintToken()}` });
}

// Evidencia y etiquetas de cambios web (cuerpos grandes) no pasan por el parser
// global: las parsea su router con 25 MB después del guard. El resto, igual que siempre.
app.use(jsonExceptBigBodies(express.json()));
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

// Light poll for the TV screen: today's sales and the latest orders only.
app.get('/api/event/pulse', requireAuth, async (req, res) => {
  try {
    const eventId = req.query.event || 'cyber';
    if (!EVENTS[eventId]) return res.status(400).json({ ok: false, error: `Unknown event: ${eventId}` });
    res.json({ ok: true, ...(await getEventPulse(eventId)) });
  } catch (err) {
    console.error('[server] event pulse error:', err);
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

// Pinterest Ads (gasto y conversiones reportadas por día)
app.get('/api/v3/pinterest/status', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await getPinterestStatus()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/v3/pinterest/sync', requireAuth, async (req, res) => {
  if (!isPinterestConfigured()) return res.status(400).json({ ok: false, error: 'Pinterest no está configurado' });
  const r = await syncPinterestAds({ days: Math.min(365, Number(req.body?.days) || 35) });
  if (r.ok) clearPautaRealCache();
  res.status(r.ok ? 200 : 502).json(r);
});

// Perfit: campañas del período y automatizaciones
app.get('/api/v3/perfit', requireAuth, async (req, res) => {
  try {
    if (!isPerfitConfigured()) return res.json({ ok: true, configured: false });
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, configured: true, ...(await getPerfitSummary(ventasRange(params), argDay(new Date().toISOString()))) });
  } catch (err) {
    console.error('[server] perfit error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Costos de canales sin API de gasto (Pinterest a mano, abono de Perfit), por mes
app.get('/api/v3/marketing-costs', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, costs: await getMarketingCosts() });
  } catch (err) {
    console.error('[server] marketing-costs:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudieron leer los costos' });
  }
});
app.put('/api/v3/marketing-costs', requireAuth, async (req, res) => {
  try {
    const { key, month, value } = req.body || {};
    const saved = await setMarketingCost({ key, month, value: value === null ? null : Number(value) });
    clearPautaRealCache();
    res.json({ ok: true, ...saved });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    console.error('[server] marketing-costs:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo guardar el costo' });
  }
});

app.get('/api/v3/pauta-real', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getPautaReal(params)) });
  } catch (err) {
    console.error('[server] v3 pauta-real error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v3/pauta-real/clientes', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getPautaClientes(params)) });
  } catch (err) {
    console.error('[server] v3 pauta-real clientes error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v3/ventas', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    const channel = typeof req.query.channel === 'string' && /^[a-z_]{1,20}$/.test(req.query.channel) ? req.query.channel : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.slice(0, 200) : undefined;
    res.json({ ok: true, ...(await listVentas({ range: ventasRange(params), channel, q, cursor })) });
  } catch (err) {
    console.error('[server] v3 ventas error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Visitas, carritos y compras por canal (script propio de la tienda)
app.get('/api/v3/visitas', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    const range = ventasRange(params);
    const [channels, insights, alerts] = await Promise.all([
      fetchTrackingChannels(range.start, range.end),
      fetchTrackingInsights(range.start, range.end),
      fetchTrackingAlerts().catch((err) => ({ alerts: [], error: err.message })),
    ]);
    res.json({ ok: true, range, ...channels, insights, alerts: alerts.alerts });
  } catch (err) {
    console.error('[server] v3 visitas error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/v3/ventas/:id', requireAuth, async (req, res) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    res.json({ ok: true, venta: await getVenta(req.params.id) });
  } catch (err) {
    console.error('[server] v3 venta error:', err);
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

app.get('/api/v3/lectores', requireAuth, async (req, res) => {
  try {
    const { params, error } = parseReportParams(req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...(await getLectores(params)) });
  } catch (err) {
    console.error('[server] lectores error:', err);
    res.status(500).json({ ok: false, error: 'No se pudieron leer las consultas de los lectores' });
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
    try {
      await syncCreditNotes(categoryBySku);
    } catch (err) {
      console.error('[cron] creditNotes sync error:', err.message);
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
// 4-hourly full sync so the live tab is current. Every 2 min: the TV screen
// celebrates each sale as it lands, so it should land soon after it happens.
const LIVE_SYNC_MINUTES = parseInt(process.env.LIVE_SYNC_MINUTES || '2', 10);
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

// REPORTES_JOBS=off: solo HTTP, sin syncs, snapshots ni reintentos del POS
// (que escriben en Firestore, Odoo y ARCA). Para una segunda instancia de
// prueba mientras la de producción sigue siendo la dueña de esas tareas.
const reportesJobs = !/^(off|0|false)$/i.test(process.env.REPORTES_JOBS || '');

if (process.argv[1] === fileURLToPath(import.meta.url) && !reportesJobs) {
  console.log('[server] REPORTES_JOBS=off: sin crons ni reintentos del POS');
}

if (process.argv[1] === fileURLToPath(import.meta.url) && reportesJobs) {
  // Crons only when run as the server: importing { app } from a script must never sync.
  assertSafeDevEnv();
  if (backgroundJobsEnabled()) {
    cron.schedule(`0 */${SYNC_HOURS} * * *`, runFullSync);
    console.log(`[server] cron scheduled every ${SYNC_HOURS}h`);
    // Offset to minute 2 so it never fires in the same second as the `0 */N` full sync.
    cron.schedule(`2-59/${LIVE_SYNC_MINUTES} * * * *`, runLiveSalesSync);
    // Daily snapshots (Clarity, web stock): 00:05 ART, retried at 06:00 and
    // 12:00 only if the day is still missing (each run checks first).
    for (const expr of ['5 0 * * *', '0 6 * * *', '0 12 * * *']) {
      cron.schedule(expr, () => takeDailySnapshots(), { timezone: 'America/Argentina/Buenos_Aires' });
    }
    // Precios de los lectores: cada 6 h a los :30 (no pisa el full sync de las :00)
    // Pinterest Ads: cada 6 h a los :45
    if (isPinterestConfigured()) {
      cron.schedule('45 */6 * * *', () => syncPinterestAds().then((r) => { if (r.ok) clearPautaRealCache(); else console.error('[pinterest] sync:', r.error); }));
    }
    // Perfit: foto diaria de las automatizaciones (sus totales son históricos; el período sale de restar fotos)
    if (isPerfitConfigured()) {
      const snap = () => snapshotAutomations(argDay(new Date().toISOString())).catch((err) => console.error('[perfit] foto:', err.message));
      cron.schedule('55 23 * * *', snap, { timezone: 'America/Argentina/Buenos_Aires' });
      snap();
    }
    cron.schedule('30 */6 * * *', () => runPickSync().catch((err) => console.error('[pick] sync programado falló:', err.message)));
    startPosAutoRetry();
  } else {
    console.log('[server] modo dev: crons apagados, escrituras Odoo simuladas');
  }
  seedPosConfigIfNeeded().catch(err => console.error('[pos] Error cargando configuración inicial:', err.message));
  seedSuperadminIfNeeded().catch(err => console.error('[pos] Error creando superadmin:', err.message));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT} (clarity=${isClarityConfigured() ? "si" : "no"}, ga4=${isGa4Configured() ? "si" : "no"})`));
  // Ventas (ex gineza): si falla al arrancar, Reportes sigue andando y /api/gz cae al proxy.
  if (isVentasConfigured()) {
    startVentas()
      .then(async (v) => {
        await mountVentas(v, { selfUrl: `http://127.0.0.1:${PORT}` });
        console.log('[ventas] módulo montado en /api/gz, /webhooks e /ingest');
        await v.startJobs();
      })
      .catch((err) => console.error('[ventas] no arrancó, sigo con el proxy a gineza:', err));
  }
}
