import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createOrdersRepo } from './repo/orders.js';
import { createMetaRepo } from './repo/meta.js';
import { createSyncRunsRepo } from './repo/syncRuns.js';
import { createReportsRepo } from './repo/reports.js';
import { createTiendanubeClient } from './services/tiendanube.js';
import { createMetaClient } from './services/meta.js';
import { createOrderSync } from './sync/orders.js';
import { createMetaSync } from './sync/meta.js';
import { createUrlTagger } from './sync/urlTagger.js';
import { createJobRunner } from './sync/jobs.js';
import { createJobCatalog } from './jobsCatalog.js';
import { artDate, addDays } from './engine/dates.js';
import Anthropic from '@anthropic-ai/sdk';
import { createAdsRepo } from './repo/ads.js';
import { adsConfigFromEnv, createMetaAgentRunner, createExecutor, createIdentity } from './ads/agent.js';
import { createMetaBaselineTaker } from './ads/baseline.js';
import { createAdsRouter } from './routes/ads.js';
import { createGoogleAdsClient } from './services/googleAds.js';
import { createGoogleExecutor } from './gads/executor.js';
import { createGoogleAgentRunner } from './gads/agent.js';
import { createGoogleBaselineTaker } from './gads/baseline.js';
import { createGadsRouter } from './routes/gads.js';
import { createGoogleRepo } from './repo/google.js';
import { createGa4Client } from './services/ga4.js';
import { createGa4Repo } from './repo/ga4.js';
import { createGa4Sync } from './sync/ga4.js';
import { createIngestRouter } from './routes/ingest.js';
import { createApp } from './app.js';
import { createWebhookRouter } from './routes/webhooks.js';
import { createApiRouter } from './routes/api.js';
import { createAuthMiddleware } from './routes/authMiddleware.js';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta env var: ${k}`);
  return v;
};

const db = createPgDb(env('DATABASE_URL'));
const applied = await migrate(db);
if (applied.length) console.log('[db] migraciones aplicadas:', applied.join(', '));

const syncRuns = createSyncRunsRepo(db);
await syncRuns.markStaleRunning();
const ordersRepo = createOrdersRepo(db);
const metaRepo = createMetaRepo(db);
const reports = createReportsRepo(db);

const tn = createTiendanubeClient({ storeId: env('TIENDANUBE_STORE_ID'), token: env('TIENDANUBE_TOKEN') });
const meta = createMetaClient({ accessToken: env('META_ACCESS_TOKEN'), accountId: env('META_ACCOUNT_ID') });
const orderSync = createOrderSync({ tn, ordersRepo });
const metaSync = createMetaSync({ meta, metaRepo, ordersRepo });
const urlTagger = createUrlTagger({ meta, metaRepo });
const jobs = createJobRunner({ syncRuns });
// GA4 es opcional: sin la cuenta de servicio no hay job ni cron
const ga4Sync = process.env.GA4_SERVICE_ACCOUNT && process.env.GA4_PROPERTY_ID
  ? createGa4Sync({ ga4: createGa4Client({ serviceAccountJson: process.env.GA4_SERVICE_ACCOUNT, propertyId: process.env.GA4_PROPERTY_ID }), ga4Repo: createGa4Repo(db) })
  : null;
const jobCatalog = createJobCatalog({ orderSync, metaSync, ga4Sync, ordersRepo, syncRuns });
const runJob = (name) => jobs.run(jobCatalog[name].source, jobCatalog[name].fn);

// Agente de pauta (mismo que uniformar, con ventas reales de la tienda como métrica)
const adsRepo = createAdsRepo(db);
await adsRepo.markStaleRuns();
const adsConfig = adsConfigFromEnv();
const identity = createIdentity({ meta, config: adsConfig });
const execute = createExecutor({ meta, repo: adsRepo, config: adsConfig, identity });
const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
const agentModel = process.env.ADS_AGENT_MODEL || undefined;
const startAdsRun = createMetaAgentRunner({
  anthropic, meta, reports, repo: adsRepo, execute, identity, model: agentModel,
});
const takeMetaBaseline = createMetaBaselineTaker({ meta, repo: adsRepo });

// Agente de Google: opcional, sin la cuenta de servicio no hay cliente, ni corridas, ni cron (el panel avisa con 503)
const gads = process.env.GOOGLE_ADS_SERVICE_ACCOUNT && process.env.GOOGLE_ADS_CUSTOMER_ID
  ? createGoogleAdsClient({ serviceAccountJson: process.env.GOOGLE_ADS_SERVICE_ACCOUNT, customerId: process.env.GOOGLE_ADS_CUSTOMER_ID })
  : null;
const gadsRepo = createAdsRepo(db, { platform: 'google' });
await gadsRepo.markStaleRuns();
const gadsExecute = gads ? createGoogleExecutor({ gads, repo: gadsRepo }) : null;
const startGadsRun = gads ? createGoogleAgentRunner({ anthropic, gads, repo: gadsRepo, execute: gadsExecute, model: agentModel }) : null;
const takeGoogleBaseline = gads ? createGoogleBaselineTaker({ gads, repo: gadsRepo }) : undefined;

// Agente ya prendido sin foto del antes (cuentas que lo tenían activo antes de esta versión): se toma ahora, sin frenar el arranque
async function baselineOnDeploy(repo, take, label) {
  if (!take) return;
  try {
    const settings = await repo.getSettings();
    if (settings.agent_enabled && (await repo.lastBaseline()) === undefined) await take('deploy');
  } catch (err) {
    console.error(`[${label}] no pude guardar la línea de base al desplegar:`, err);
  }
}
baselineOnDeploy(adsRepo, takeMetaBaseline, 'ads');
baselineOnDeploy(gadsRepo, takeGoogleBaseline, 'gads');

async function onOrderEvent(event) {
  try {
    await orderSync.syncOrder(event.id);
  } catch (err) {
    console.error(`[webhook] orden ${event.id}:`, err);
    const id = await syncRuns.start('tn_webhook');
    await syncRuns.finish(id, { status: 'error', error: `orden ${event.id}: ${err.message}` });
  }
}

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
const app = createApp({
  corsOrigin: process.env.FRONTEND_ORIGIN,
  ingestRouter: createIngestRouter({ token: process.env.GOOGLE_INGEST_TOKEN, googleRepo: createGoogleRepo(db), syncRuns }),
  webhookRouter: createWebhookRouter({ secret: process.env.TIENDANUBE_WEBHOOK_SECRET, onOrderEvent }),
  apiRouter: [
    createAuthMiddleware({ password: env('DASHBOARD_PASSWORD') }),
    // El del agente va primero: sus rutas fijas (/ads/overview, /ads/creatives…) si no las agarra GET /ads/:id
    createAdsRouter({ repo: adsRepo, meta, reports, startRun: startAdsRun, execute, identity, config: adsConfig, takeBaseline: takeMetaBaseline }),
    createGadsRouter({ repo: gadsRepo, gads, startRun: startGadsRun, execute: gadsExecute, config: adsConfig, takeBaseline: takeGoogleBaseline }),
    createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }),
  ],
  staticDir: fs.existsSync(path.join(distDir, 'index.html')) ? distDir : undefined,
  health: async () => {
    await db.query('SELECT 1');
    return { db: true };
  },
});

const TZ = { timezone: 'America/Argentina/Buenos_Aires' };
// Red de seguridad de órdenes (webhooks perdidos) — cada hora
cron.schedule('5 * * * *', () => runJob('tn-incremental'), TZ);
// Catálogo (solo lo cambiado) + gasto de hoy/ayer — cada hora
cron.schedule('15 * * * *', async () => {
  await runJob('meta-catalog-recent');
  await jobs.run('meta_spend', () => {
    const today = artDate();
    return metaSync.syncSpend(addDays(today, -1), today);
  });
}, TZ);
// Correcciones tardías de Meta — últimos 7 días, 05:00 ART
cron.schedule('0 5 * * *', () => runJob('meta-spend'), TZ);
// Catálogo completo una vez por día, de madrugada: estados heredados (campaña pausada) que no cambian updated_time
cron.schedule('30 3 * * *', () => runJob('meta-catalog'), TZ);

// Análisis diario del agente de pauta: gasto de Meta y órdenes al día, después la corrida (08:00 ART).
// Sin catálogo: el agente lee la estructura en vivo y un catálogo más antes de correr le comía el límite de llamadas a Meta
cron.schedule('0 8 * * *', async () => {
  await runJob('meta-spend');
  await runJob('tn-incremental');
  try {
    const { done } = await startAdsRun('daily');
    const run = await done;
    console.log(`[ads] corrida diaria: ${run.status}`);
  } catch (err) {
    console.error('[ads] corrida diaria no arrancó:', err.message);
  }
}, TZ);
// Análisis diario del agente de Google (08:15 ART, después del de Meta): lee todo en vivo de la API de Google
if (startGadsRun) {
  cron.schedule('15 8 * * *', async () => {
    try {
      const { done } = await startGadsRun('daily');
      const run = await done;
      console.log(`[gads] corrida diaria: ${run.status}`);
    } catch (err) {
      console.error('[gads] corrida diaria no arrancó:', err.message);
    }
  }, TZ);
}
// GA4 procesa con demora: cada hora se re-trae los últimos 3 días
if (ga4Sync) cron.schedule('40 * * * *', () => runJob('ga4'), TZ);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`altorancho-backend escuchando en :${port}`));
