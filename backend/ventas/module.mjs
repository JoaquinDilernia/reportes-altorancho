// Módulo Ventas: lo que era el backend de gineza-agent (altorancho-ventas),
// dentro de Reportes. Pedidos de Tienda Nube con su atribución, gasto de Meta
// y Google, GA4 y los agentes de pauta, sobre Postgres.
//
// Se prende con DATABASE_URL. Las variables aceptan un override VENTAS_<NOMBRE>
// (p. ej. VENTAS_META_ACCESS_TOKEN) para no chocar con las de Reportes.
//
// Dos modos, para poder convivir con el servicio viejo durante el corte:
// - pasivo (default): lee y sirve la API (tablero, listado, agente a demanda).
//   No corre crons ni toca corridas ajenas al arrancar.
// - dueño (VENTAS_JOBS=on): además corre los crons (pedidos, gasto, GA4,
//   agentes 08:00/08:15) y ordena el estado al arrancar. Uno solo por base.
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { createPgDb } from './src/db/index.js';
import { migrate } from './src/db/migrate.js';
import { createOrdersRepo } from './src/repo/orders.js';
import { createMetaRepo } from './src/repo/meta.js';
import { createSyncRunsRepo } from './src/repo/syncRuns.js';
import { createReportsRepo } from './src/repo/reports.js';
import { createTiendanubeClient } from './src/services/tiendanube.js';
import { createMetaClient } from './src/services/meta.js';
import { createOrderSync } from './src/sync/orders.js';
import { createMetaSync } from './src/sync/meta.js';
import { createUrlTagger } from './src/sync/urlTagger.js';
import { createJobRunner } from './src/sync/jobs.js';
import { createJobCatalog } from './src/jobsCatalog.js';
import { artDate, addDays } from './src/engine/dates.js';
import { createAdsRepo } from './src/repo/ads.js';
import { adsConfigFromEnv, createMetaAgentRunner, createExecutor, createIdentity } from './src/ads/agent.js';
import { createMetaBaselineTaker } from './src/ads/baseline.js';
import { createAdsRouter } from './src/routes/ads.js';
import { createGoogleAdsClient } from './src/services/googleAds.js';
import { createGoogleExecutor } from './src/gads/executor.js';
import { createGoogleAgentRunner } from './src/gads/agent.js';
import { createGoogleBaselineTaker } from './src/gads/baseline.js';
import { createGadsRouter } from './src/routes/gads.js';
import { createGoogleRepo } from './src/repo/google.js';
import { createGa4Client } from './src/services/ga4.js';
import { createGa4Repo } from './src/repo/ga4.js';
import { createGa4Sync } from './src/sync/ga4.js';
import { createIngestRouter } from './src/routes/ingest.js';
import { createWebhookRouter } from './src/routes/webhooks.js';
import { createApiRouter } from './src/routes/api.js';

export function ventasEnv(source = process.env) {
  const get = (k) => source[`VENTAS_${k}`] || source[k] || undefined;
  return {
    databaseUrl: get('DATABASE_URL'),
    jobs: /^(on|1|true)$/i.test(source.VENTAS_JOBS || ''),
    tnStoreId: get('TIENDANUBE_STORE_ID') || source.TN_STORE_ID,
    tnToken: get('TIENDANUBE_TOKEN') || source.TN_ACCESS_TOKEN,
    tnWebhookSecret: get('TIENDANUBE_WEBHOOK_SECRET'),
    metaToken: get('META_ACCESS_TOKEN'),
    metaAccountId: get('META_ACCOUNT_ID') || (source.META_AD_ACCOUNT_ID || '').replace(/^act_/, '') || undefined,
    anthropicKey: get('ANTHROPIC_API_KEY'),
    agentModel: get('ADS_AGENT_MODEL'),
    gadsServiceAccount: get('GOOGLE_ADS_SERVICE_ACCOUNT'),
    gadsCustomerId: get('GOOGLE_ADS_CUSTOMER_ID'),
    ga4ServiceAccount: get('GA4_SERVICE_ACCOUNT'),
    ga4PropertyId: get('GA4_PROPERTY_ID'),
    googleIngestToken: get('GOOGLE_INGEST_TOKEN'),
    adsConfig: adsConfigFromEnv(Object.fromEntries(['META_ADS_PAGE_ID', 'META_ADS_IG_USER_ID', 'META_ADS_PIXEL_ID', 'STORE_URL'].map((k) => [k, get(k)]))),
  };
}

export const isVentasConfigured = (source = process.env) => Boolean(ventasEnv(source).databaseUrl);

const need = (v, name) => {
  if (!v) throw new Error(`Ventas: falta ${name}`);
  return v;
};

// opts.db: una base ya abierta (tests con PGlite); si no, se conecta a DATABASE_URL.
export async function startVentas(source = process.env, { log = console, db: injected } = {}) {
  const e = ventasEnv(source);
  const db = injected || createPgDb(need(e.databaseUrl, 'DATABASE_URL'));
  const applied = await migrate(db);
  if (applied.length) log.log('[ventas] migraciones aplicadas:', applied.join(', '));

  const syncRuns = createSyncRunsRepo(db);
  const ordersRepo = createOrdersRepo(db);
  const metaRepo = createMetaRepo(db);
  const reports = createReportsRepo(db);
  const tn = createTiendanubeClient({ storeId: need(e.tnStoreId, 'TIENDANUBE_STORE_ID'), token: need(e.tnToken, 'TIENDANUBE_TOKEN') });
  const meta = createMetaClient({ accessToken: need(e.metaToken, 'META_ACCESS_TOKEN'), accountId: need(e.metaAccountId, 'META_ACCOUNT_ID') });
  const orderSync = createOrderSync({ tn, ordersRepo });
  const metaSync = createMetaSync({ meta, metaRepo, ordersRepo });
  const urlTagger = createUrlTagger({ meta, metaRepo });
  const jobs = createJobRunner({ syncRuns });
  const ga4Sync = e.ga4ServiceAccount && e.ga4PropertyId
    ? createGa4Sync({ ga4: createGa4Client({ serviceAccountJson: e.ga4ServiceAccount, propertyId: e.ga4PropertyId }), ga4Repo: createGa4Repo(db) })
    : null;
  const jobCatalog = createJobCatalog({ orderSync, metaSync, ga4Sync, ordersRepo, syncRuns });
  const runJob = (name) => jobs.run(jobCatalog[name].source, jobCatalog[name].fn);

  const adsRepo = createAdsRepo(db);
  const identity = createIdentity({ meta, config: e.adsConfig });
  const execute = createExecutor({ meta, repo: adsRepo, config: e.adsConfig, identity });
  const anthropic = new Anthropic({ apiKey: need(e.anthropicKey, 'ANTHROPIC_API_KEY') });
  const startAdsRun = createMetaAgentRunner({ anthropic, meta, reports, repo: adsRepo, execute, identity, model: e.agentModel });
  const takeMetaBaseline = createMetaBaselineTaker({ meta, repo: adsRepo });

  const gads = e.gadsServiceAccount && e.gadsCustomerId
    ? createGoogleAdsClient({ serviceAccountJson: e.gadsServiceAccount, customerId: e.gadsCustomerId })
    : null;
  const gadsRepo = createAdsRepo(db, { platform: 'google' });
  const gadsExecute = gads ? createGoogleExecutor({ gads, repo: gadsRepo }) : null;
  const startGadsRun = gads ? createGoogleAgentRunner({ anthropic, gads, repo: gadsRepo, execute: gadsExecute, model: e.agentModel }) : null;
  const takeGoogleBaseline = gads ? createGoogleBaselineTaker({ gads, repo: gadsRepo }) : undefined;

  async function onOrderEvent(event) {
    try {
      await orderSync.syncOrder(event.id);
    } catch (err) {
      log.error(`[ventas webhook] orden ${event.id}:`, err);
      const id = await syncRuns.start('tn_webhook');
      await syncRuns.finish(id, { status: 'error', error: `orden ${event.id}: ${err.message}` });
    }
  }

  // Rutas de la API de gineza, sin su auth: Reportes pone la suya adelante.
  // El del agente va primero: sus rutas fijas (/ads/overview…) si no las agarra GET /ads/:id
  const apiRouters = [
    createAdsRouter({ repo: adsRepo, meta, reports, startRun: startAdsRun, execute, identity, config: e.adsConfig, takeBaseline: takeMetaBaseline }),
    createGadsRouter({ repo: gadsRepo, gads, startRun: startGadsRun, execute: gadsExecute, config: e.adsConfig, takeBaseline: takeGoogleBaseline }),
    createApiRouter({ reports, syncRuns, metaRepo, urlTagger, jobs, jobCatalog }),
  ];
  const webhookRouter = createWebhookRouter({ secret: e.tnWebhookSecret, onOrderEvent });
  const ingestRouter = createIngestRouter({ token: e.googleIngestToken, googleRepo: createGoogleRepo(db), syncRuns });

  async function ownStartup() {
    await syncRuns.markStaleRunning();
    await adsRepo.markStaleRuns();
    await gadsRepo.markStaleRuns();
    for (const [repo, take, label] of [[adsRepo, takeMetaBaseline, 'ads'], [gadsRepo, takeGoogleBaseline, 'gads']]) {
      if (!take) continue;
      try {
        const settings = await repo.getSettings();
        if (settings.agent_enabled && (await repo.lastBaseline()) === undefined) await take('deploy');
      } catch (err) {
        log.error(`[ventas ${label}] no pude guardar la línea de base al desplegar:`, err);
      }
    }
  }

  // Mismos horarios que tenía el servicio altorancho-ventas.
  function scheduleJobs() {
    const TZ = { timezone: 'America/Argentina/Buenos_Aires' };
    cron.schedule('5 * * * *', () => runJob('tn-incremental'), TZ);
    cron.schedule('15 * * * *', async () => {
      await runJob('meta-catalog-recent');
      await jobs.run('meta_spend', () => {
        const today = artDate();
        return metaSync.syncSpend(addDays(today, -1), today);
      });
    }, TZ);
    cron.schedule('0 5 * * *', () => runJob('meta-spend'), TZ);
    cron.schedule('30 3 * * *', () => runJob('meta-catalog'), TZ);
    cron.schedule('0 8 * * *', async () => {
      await runJob('meta-spend');
      await runJob('tn-incremental');
      try {
        const { done } = await startAdsRun('daily');
        log.log(`[ventas ads] corrida diaria: ${(await done).status}`);
      } catch (err) {
        log.error('[ventas ads] corrida diaria no arrancó:', err.message);
      }
    }, TZ);
    if (startGadsRun) {
      cron.schedule('15 8 * * *', async () => {
        try {
          const { done } = await startGadsRun('daily');
          log.log(`[ventas gads] corrida diaria: ${(await done).status}`);
        } catch (err) {
          log.error('[ventas gads] corrida diaria no arrancó:', err.message);
        }
      }, TZ);
    }
    if (ga4Sync) cron.schedule('40 * * * *', () => runJob('ga4'), TZ);
  }

  return {
    db,
    reports,
    apiRouters,
    webhookRouter,
    ingestRouter,
    ownsJobs: e.jobs,
    // Lo llama el server (no los scripts ni los tests).
    async startJobs() {
      if (!e.jobs) {
        log.log('[ventas] modo pasivo: sin crons (VENTAS_JOBS no está prendido)');
        return;
      }
      await ownStartup();
      scheduleJobs();
      log.log('[ventas] crons prendidos (este servicio es el dueño de la base)');
    },
    health: async () => {
      await db.query('SELECT 1');
      return true;
    },
  };
}
