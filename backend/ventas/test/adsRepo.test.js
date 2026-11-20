import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { createAdsRepo } from '../src/repo/ads.js';

describe('repo del agente por plataforma', () => {
  let db;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(() => db.close());

  it('cada plataforma ve solo lo suyo', async () => {
    const meta = createAdsRepo(db), google = createAdsRepo(db, { platform: 'google' });
    const d = await google.addDecision({ tool: 'set_status', input: {}, status: 'pending' });
    expect(await meta.listDecisions({ status: 'pending' })).toEqual([]);
    expect((await google.listDecisions({ status: 'pending' })).map((x) => x.id)).toEqual([d.id]);
    await expect(meta.claimPending(d.id, 'executed')).rejects.toMatchObject({ status: 404 });
    expect(await meta.countPending()).toBe(0);
  });
  it('ajustes por plataforma: Google arranca apagado, Meta conserva lo que tenía', async () => {
    expect(await createAdsRepo(db).getSettings()).toMatchObject({ agent_enabled: true, autonomous: false, auto_pause_min_spend_ars: 0, auto_pause_days: 7 });
    expect(await createAdsRepo(db, { platform: 'google' }).getSettings()).toMatchObject({ agent_enabled: false, autonomous: false, purchase_action: null });
  });
  it('cada cambio de ajustes queda en la bitácora con valor anterior y nuevo', async () => {
    const g = createAdsRepo(db, { platform: 'google' });
    const { changed } = await g.updateSettings({ agent_enabled: true, auto_pause_days: 7 });
    expect(changed).toEqual(['agent_enabled']);
    expect((await g.listSettingsLog())[0]).toMatchObject({ platform: 'google', field: 'agent_enabled', old_value: false, new_value: true });
  });
  it('línea de base por plataforma', async () => {
    const g = createAdsRepo(db, { platform: 'google' });
    await g.addBaseline({ reason: 'activated', data: { roas: 4 } });
    expect(await createAdsRepo(db).lastBaseline()).toBeUndefined();
    expect((await g.lastBaseline()).data).toEqual({ roas: 4 });
  });
});
