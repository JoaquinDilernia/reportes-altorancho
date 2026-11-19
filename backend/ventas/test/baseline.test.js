import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { buildAdsApp, fakeMeta } from './helpers/adsFakes.js';
import { buildMetaBaseline } from '../src/ads/baseline.js';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/routes/authMiddleware.js';
import { createAdsRepo } from '../src/repo/ads.js';
import { mountAgentRoutes } from '../src/routes/agentRoutes.js';

async function waitFor(fn, { tries = 100, ms = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error('waitFor: no se cumplió');
}

describe('línea de base y ajustes nuevos', () => {
  let db, app, repo;
  beforeAll(async () => {
    db = await createTestDb();
    app = buildAdsApp({ db });
    repo = app.repo;
  });
  afterAll(() => db.close());

  it('prender el agente guarda la línea de base y la bitácora', async () => {
    await app.call('put', '/api/ads/settings').send({ agent_enabled: false });
    await app.call('put', '/api/ads/settings').send({ agent_enabled: true });
    await waitFor(() => repo.lastBaseline());
    expect((await repo.lastBaseline())).toMatchObject({ reason: 'activated', data: { campaigns: [{ id: '900', family: 'sales' }] } });
    expect((await repo.listSettingsLog()).map((l) => l.field)).toEqual(['agent_enabled', 'agent_enabled']);
  });

  it('ajustes nuevos: valida mínimo y período', async () => {
    expect((await app.call('put', '/api/ads/settings').send({ auto_pause_days: 0 })).status).toBe(400);
    expect((await app.call('put', '/api/ads/settings').send({ auto_pause_min_spend_ars: 50000, auto_pause_days: 7 })).body.settings)
      .toMatchObject({ auto_pause_min_spend_ars: 50000, auto_pause_days: 7 });
    expect((await app.call('put', '/api/ads/settings').send({ purchase_action: 'x' })).status).toBe(400); // Meta no tiene ese campo
  });
});

describe('buildMetaBaseline', () => {
  it('últimos 30 días por campaña; la cuenta suma por familia y recalcula ratios', async () => {
    const meta = fakeMeta();
    const asked = [];
    meta.getCampaigns = async () => [
      { id: '900', name: 'AR | VENTAS', objective: 'OUTCOME_SALES' },
      { id: '910', name: 'AR | VENTAS 2', objective: 'CONVERSIONS' },
    ];
    meta.getByIds = async (level, ids) => ids.map((id) => ({ id, name: `PAUSADO ${id}`, objective: 'OUTCOME_TRAFFIC' }));
    meta.getInsights = async (level, from, to) => {
      asked.push([level, from, to]);
      return [
        { campaign_id: '900', spend: '1000', actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '5000' }] },
        { campaign_id: '910', spend: '3000', actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '3000' }] },
        { campaign_id: '920', spend: '500', clicks: '50', impressions: '1000' },
      ];
    };
    const b = await buildMetaBaseline({ meta, now: new Date('2026-10-21T15:00:00Z') });
    expect(asked).toEqual([['campaign', '2026-09-22', '2026-10-21']]);
    expect(b.period).toEqual({ from: '2026-09-22', to: '2026-10-21' });
    expect(b.account.sales).toMatchObject({ spend: 4000, purchases: 3, purchaseValue: 8000, roas: 2, cpa: 1333 });
    expect(b.campaigns.find((c) => c.id === '910')).toMatchObject({ name: 'AR | VENTAS 2', family: 'sales', metrics: { roas: 1 } });
    // Campaña fuera del listado: se pide por id
    expect(b.campaigns.find((c) => c.id === '920')).toMatchObject({ name: 'PAUSADO 920', family: 'traffic' });
    expect(b.account.traffic).toMatchObject({ spend: 500, clicks: 50, ctr: 5, cpc: 10 });
    expect(b.campaigns.map((c) => c.id)).toEqual(['910', '900', '920']);
  });
});

describe('rutas comunes con otra plataforma', () => {
  it('Google acepta purchase_action; si la línea de base falla, va al log y el ajuste se guarda igual', async () => {
    const db = await createTestDb();
    const repo = createAdsRepo(db, { platform: 'google' });
    const errors = [];
    const router = express.Router();
    mountAgentRoutes(router, {
      base: '/gads', repo, startRun: null, execute: null, need: (_q, _s, next) => next(),
      takeBaseline: async () => { throw new Error('Google no respondió'); }, allowPurchaseAction: true, log: { error: (...a) => errors.push(a) },
    });
    const app = createApp({ apiRouter: [createAuthMiddleware({ password: 'pw' }), router] });
    const put = (body) => request(app).put('/api/gads/settings').set('authorization', 'Bearer pw').send(body);
    expect((await put({ purchase_action: 'customers/123/conversionActions/456' })).body.settings.purchase_action).toBe('customers/123/conversionActions/456');
    expect((await put({ purchase_action: null })).body.settings.purchase_action).toBeNull();
    expect((await put({ purchase_action: 'x' })).status).toBe(400);
    expect((await put({ agent_enabled: true })).body.settings.agent_enabled).toBe(true);
    await waitFor(() => errors.length);
    expect(String(errors[0][1].message)).toMatch(/Google no respondió/);
    expect(await repo.lastBaseline()).toBeUndefined();
    await db.close();
  });
});
