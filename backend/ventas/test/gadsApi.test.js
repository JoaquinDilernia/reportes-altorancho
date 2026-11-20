import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { buildGadsApp, fakeGoogleAds, PURCHASE_ACTION } from './helpers/gadsFakes.js';
import { fakeMeta, fakeAnthropic, waitRun, PNG_1x1 } from './helpers/adsFakes.js';

const rn = (type, id) => `customers/8132886784/${type}/${id}`;
const mutates = (gads) => gads.calls.filter((c) => c[0] === 'mutate');

let db;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec("DELETE FROM ad_decisions; DELETE FROM ad_creative_media; DELETE FROM ad_creatives; DELETE FROM ad_runs; UPDATE ad_settings SET purchase_action = NULL, agent_enabled = false;");
});

describe('rutas de Google sin credenciales', () => {
  it('sin credenciales de Google responde 503 en lo que toca Google y el resto anda', async () => {
    const { call } = buildGadsApp({ db, gads: null });
    const overview = await call('get', '/api/gads/overview');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ configured: { google: false, agent: false }, snapshot: null, googleError: null, purchaseAction: null });
    expect((await call('get', '/api/gads/conversion-actions')).status).toBe(503);
    expect((await call('post', '/api/gads/runs')).status).toBe(503);
    expect((await call('post', '/api/gads/objects/201/status').send({ level: 'ad_group', status: 'PAUSED' })).status).toBe(503);
    expect((await call('get', '/api/gads/badge')).body).toEqual({ pendingCount: 0, openQuestions: 0 });
    expect((await call('get', '/api/gads/creatives')).status).toBe(200);
    const meta = await call('get', '/api/ads/overview');
    expect(meta.status).toBe(200);
    expect(meta.body.configured.meta).toBe(true);
  });
});

describe('rutas de Google', () => {
  let app;
  let gads;
  beforeEach(() => {
    gads = fakeGoogleAds();
    app = buildGadsApp({ db, gads });
  });

  it('overview cachea: dos pedidos seguidos hacen una sola foto', async () => {
    const first = await app.call('get', '/api/gads/overview');
    expect(first.status).toBe(200);
    expect(first.body.configured).toEqual({ google: true, agent: false });
    expect(first.body.purchaseAction).toMatchObject({ resourceName: PURCHASE_ACTION, auto: true });
    expect(first.body.snapshot.campaigns.map((c) => c.id)).toEqual(expect.arrayContaining(['101', '102', '103']));
    const firstCount = gads.searchCount;
    await app.call('get', '/api/gads/overview');
    expect(gads.searchCount).toBe(firstCount);
    // Cambiar la acción de compra vuelve a sacar la foto
    const other = rn('conversionActions', 2);
    expect((await app.call('put', '/api/gads/settings').send({ purchase_action: other })).status).toBe(200);
    const after = await app.call('get', '/api/gads/overview');
    expect(after.body.purchaseAction).toMatchObject({ resourceName: other, auto: false });
    expect(gads.searchCount).toBeGreaterThan(firstCount);
  });

  it('Google caído: avisa el error y no le vuelve a pegar en cada recarga', async () => {
    let n = 0;
    gads.search = async () => { n += 1; throw new Error('Google Ads 500: interno'); };
    const first = await app.call('get', '/api/gads/overview');
    expect(first.status).toBe(200);
    expect(first.body.googleError).toMatch(/interno/);
    expect((await app.call('get', '/api/gads/overview')).body.googleError).toMatch(/interno/);
    expect(n).toBe(1);
  });

  it('acciones de conversión y ajuste de acción de compra validado', async () => {
    const res = await app.call('get', '/api/gads/conversion-actions');
    expect(res.status).toBe(200);
    expect(res.body.actions.map((a) => a.name)).toEqual(['Vista de página', 'ALTORANCHO - GA4 (web) purchase', 'Compra (Tag de Google)']);
    expect((await app.call('put', '/api/gads/settings').send({ purchase_action: 'cualquiera' })).status).toBe(400);
    expect((await app.call('put', '/api/gads/settings').send({ purchase_action: null })).status).toBe(200);
  });

  it('id de palabra clave inválido → 400', async () => {
    const res = await app.call('post', '/api/gads/objects/123/status').send({ level: 'keyword', status: 'PAUSED' });
    expect(res.status).toBe(400);
    expect((await app.call('post', '/api/gads/objects/abc/status').send({ level: 'ad_group', status: 'PAUSED' })).status).toBe(400);
    expect((await app.call('post', '/api/gads/objects/201/status').send({ level: 'ad', status: 'PAUSED' })).status).toBe(400);
    expect((await app.call('post', '/api/gads/objects/201/status').send({ level: 'ad_group', status: 'ACTIVE' })).status).toBe(400);
    expect(mutates(gads)).toEqual([]);
  });

  it('pausar a mano una palabra clave la pausa en Google y queda en el historial', async () => {
    const res = await app.call('post', '/api/gads/objects/201~301/status').send({ level: 'keyword', status: 'PAUSED', name: 'mantas de lana' });
    expect(res.status).toBe(200);
    expect(mutates(gads)).toEqual([['mutate', 'adGroupCriteria', [{ update: { resourceName: rn('adGroupCriteria', '201~301'), status: 'PAUSED' }, updateMask: 'status' }]]]);
    const [d] = (await app.call('get', '/api/gads/decisions')).body.decisions;
    expect(d).toMatchObject({ tool: 'set_status', status: 'executed', title: 'Pausar la palabra clave mantas de lana', reason: 'Hecho a mano desde el panel.', platform: 'google' });
  });

  it('una decisión de Google no se aprueba por /api/ads', async () => {
    const d = await app.repo.addDecision({ tool: 'set_status', input: { level: 'ad_group', object_id: '201', status: 'PAUSED' }, status: 'pending', title: 'Pausar mantas', reason: 'r' });
    expect((await app.call('post', `/api/ads/decisions/${d.id}/approve`)).status).toBe(404);
    expect(mutates(gads)).toEqual([]);
    const ok = await app.call('post', `/api/gads/decisions/${d.id}/approve`);
    expect(ok.body.decision).toMatchObject({ status: 'executed' });
    expect(mutates(gads)[0][1]).toBe('adGroups');
  });
});

describe('corridas de Google', () => {
  it('si Meta está limitado, la corrida de Google termina igual', async () => {
    const meta = { ...fakeMeta(), getCampaigns: async () => { throw Object.assign(new Error('Meta 80004: too many calls'), { code: 80004 }); } };
    fakeAnthropic.firstMessage = undefined;
    const app = buildGadsApp({ db, meta, anthropic: fakeAnthropic([]) });
    expect((await app.call('get', '/api/ads/overview')).body.metaError).toMatch(/80004/);
    const res = await app.call('post', '/api/gads/runs');
    expect(res.status).toBe(202);
    const run = await waitRun(app.call, res.body.run.id, '/api/gads');
    expect(run).toMatchObject({ status: 'done', platform: 'google' });
    expect(fakeAnthropic.firstMessage).toMatch(/cuenta de Google Ads/);
  });
});

describe('piezas de Google', () => {
  let app;
  let gads;
  beforeEach(() => {
    gads = fakeGoogleAds();
    app = buildGadsApp({ db, gads });
  });
  const valid = {
    name: 'Mantas invierno',
    headlines: ['Mantas de lana', 'Abrigo para tu casa', 'Envío gratis'],
    long_headline: 'Mantas de lana tejidas a mano para el invierno',
    descriptions: ['Tejidas a mano en Argentina.', 'Hasta 6 cuotas sin interés.'],
  };

  it('pieza de Google: valida títulos y link de YouTube', async () => {
    const post = (body) => app.call('post', '/api/gads/creatives').send(body);
    expect((await post({ ...valid, headlines: [...valid.headlines.slice(0, 2), 'x'.repeat(31)] })).status).toBe(400);
    expect((await post({ ...valid, headlines: valid.headlines.slice(0, 2) })).status).toBe(400);
    expect((await post({ ...valid, descriptions: ['una sola'] })).status).toBe(400);
    expect((await post({ ...valid, long_headline: 'x'.repeat(91) })).status).toBe(400);
    expect((await post({ ...valid, youtube_url: 'https://vimeo.com/123' })).status).toBe(400);
    expect((await post({ ...valid, link: 'http://altorancho.com' })).status).toBe(400);

    const res = await post({ ...valid, youtube_url: 'https://youtu.be/abc123' });
    expect(res.status).toBe(201);
    expect(res.body.creative).toMatchObject({ ...valid, youtube_url: 'abc123', link: 'https://altorancho.com', platform: 'google', status: 'unused' });
    for (const [url, id] of [['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'dQw4w9WgXcQ'], ['youtube.com/shorts/Ab_-9', 'Ab_-9']]) {
      expect((await post({ ...valid, youtube_url: url })).body.creative.youtube_url).toBe(id);
    }

    const id = res.body.creative.id;
    const patched = await app.call('patch', `/api/gads/creatives/${id}`).send({ headlines: ['Uno', 'Dos', 'Tres', 'Cuatro'], youtube_url: '' });
    expect(patched.body.creative).toMatchObject({ headlines: ['Uno', 'Dos', 'Tres', 'Cuatro'], youtube_url: null });
    expect((await app.call('patch', `/api/gads/creatives/${id}`).send({ headlines: ['Uno'] })).status).toBe(400);
    expect((await app.call('patch', `/api/gads/creatives/${id}`).send({ status: 'archived' })).body.creative.status).toBe('archived');
  });

  it('las imágenes van a la biblioteca de Google y la pieza se publica en un grupo de recursos', async () => {
    const { body } = await app.call('post', '/api/gads/creatives').send(valid);
    const id = body.creative.id;
    const put = (slot, type, buf) => app.call('put', `/api/gads/creatives/${id}/media/${slot}`).set('content-type', type).set('x-file-name', 'manta.png').send(buf);
    expect((await put('feed', 'image/png', PNG_1x1)).status).toBe(404);
    expect((await put('landscape', 'video/mp4', Buffer.from('x'))).status).toBe(415);
    expect((await put('landscape', 'image/png', Buffer.from('no es png'))).status).toBe(415);
    const up = await put('landscape', 'image/png', PNG_1x1);
    expect(up.status).toBe(201);
    expect(up.body.media).toMatchObject({ slot: 'landscape', kind: 'image', asset_name: rn('assets', '700'), original_name: 'manta.png' });
    expect(gads.calls.filter(([n]) => n === 'uploadImageAsset')).toHaveLength(1);

    const pub = await app.call('post', `/api/gads/creatives/${id}/publish`).send({ target: 'asset_group', target_id: '401', target_name: 'genérica' });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ ok: true, resource: rn('assetGroups', '401') });
    const [d] = (await app.call('get', '/api/gads/decisions')).body.decisions;
    expect(d).toMatchObject({ tool: 'add_assets', status: 'executed', title: 'Publicar "Mantas invierno" en genérica' });
    expect((await app.call('patch', `/api/gads/creatives/${id}`).send({ name: 'otro' })).status).toBe(409);
    expect((await put('square', 'image/png', PNG_1x1)).status).toBe(409);
    expect((await app.call('post', `/api/gads/creatives/${id}/publish`).send({ target: 'campaign', target_id: '401' })).status).toBe(400);
  });
});
