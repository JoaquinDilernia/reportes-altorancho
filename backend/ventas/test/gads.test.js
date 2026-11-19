import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { fakeGoogleAds, PURCHASE_ACTION } from './helpers/gadsFakes.js';
import { fakeAnthropic, toolTurn, contextSection } from './helpers/adsFakes.js';
import { createAdsRepo } from '../src/repo/ads.js';
import { createGoogleExecutor } from '../src/gads/executor.js';
import { createGoogleDispatcher, buildGoogleContext, trimGoogleForAgent, createGoogleAgentRunner, MAX_KEYWORDS } from '../src/gads/agent.js';
import { GOOGLE_TOOLS, GOOGLE_TOOL_DEFINITIONS, GOOGLE_ACTIONS } from '../src/gads/tools.js';
import { GOOGLE_SYSTEM_PROMPT } from '../src/gads/systemPrompt.js';

const rn = (type, id) => `customers/8132886784/${type}/${id}`;
const mutates = (gads) => gads.calls.filter((c) => c[0] === 'mutate');
const why = { title: 'T', reason: 'R', expected_impact: 'E' };
const PA = { resourceName: PURCHASE_ACTION, name: 'ALTORANCHO - GA4 (web) purchase', auto: true };

// Cambia lo que responde el fake para una query que matchee
function withSearch(gads, fn) {
  const orig = gads.search;
  gads.search = async (q) => fn(q, await orig(q));
  return gads;
}
const noPurchases = (gads) => withSearch(gads, (q, rows) => (/segments\.conversion_action =/.test(q) ? [] : rows));

let db;
let repo;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec("DELETE FROM ad_decisions; DELETE FROM ad_creatives; DELETE FROM ad_questions; DELETE FROM ad_runs;");
  repo = createAdsRepo(db, { platform: 'google' });
});

describe('herramientas de Google', () => {
  it('cada acción pide título, motivo e impacto; las de equipo también están', () => {
    expect([...GOOGLE_ACTIONS]).toEqual(['set_status', 'propose_budget_change', 'add_negative_keywords', 'propose_search_ad', 'set_target_roas', 'add_assets']);
    for (const t of GOOGLE_TOOLS) expect(t.input_schema.required).toEqual(expect.arrayContaining(['title', 'reason', 'expected_impact']));
    expect(GOOGLE_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(expect.arrayContaining(['ask_team', 'request_creative', 'save_learning', 'record_outcome']));
    const ad = GOOGLE_TOOLS.find((t) => t.name === 'propose_search_ad').input_schema.properties;
    expect(ad.headlines).toMatchObject({ minItems: 3, maxItems: 15, items: { maxLength: 30 } });
    expect(ad.descriptions).toMatchObject({ minItems: 2, maxItems: 4, items: { maxLength: 90 } });
  });

  it('el prompt cubre marca, negativas, ROAS y la acción de compra', () => {
    for (const s of ['alto rancho', 'searchTerms', 'add_negative_keywords', 'una vez por semana', '±20%', 'purchaseAction', 'overrideMissing', 'ask_team']) {
      expect(GOOGLE_SYSTEM_PROMPT).toContain(s);
    }
    // Sus criterios no se presentan como umbral configurado (el primer informe habló de un "umbral para pausar" inventado)
    expect(GOOGLE_SYSTEM_PROMPT).toMatch(/El único umbral configurado es settings\.auto_pause_min_spend_ars/);
  });
});

describe('ejecutor de Google', () => {
  let gads;
  let execute;
  beforeEach(() => {
    gads = fakeGoogleAds();
    execute = createGoogleExecutor({ gads, repo });
  });

  it('aprobar pausar una palabra clave manda adGroupCriteria con status PAUSED', async () => {
    await execute('set_status', { level: 'keyword', object_id: '11~22', status: 'PAUSED' });
    expect(gads.calls).toContainEqual(['mutate', 'adGroupCriteria', [{ update: { resourceName: 'customers/8132886784/adGroupCriteria/11~22', status: 'PAUSED' }, updateMask: 'status' }]]);
    await execute('set_status', { level: 'campaign', object_id: '101', status: 'ENABLED' });
    await execute('set_status', { level: 'ad_group', object_id: '201', status: 'PAUSED' });
    expect(mutates(gads).map((c) => [c[1], c[2][0].update.resourceName])).toEqual([
      ['adGroupCriteria', rn('adGroupCriteria', '11~22')], ['campaigns', rn('campaigns', '101')], ['adGroups', rn('adGroups', '201')],
    ]);
  });

  it('ids mal formados → 400 sin tocar Google', async () => {
    await expect(execute('set_status', { level: 'keyword', object_id: '22', status: 'PAUSED' })).rejects.toMatchObject({ status: 400, message: 'Id de palabra clave inválido' });
    await expect(execute('set_status', { level: 'campaign', object_id: "1' OR 1=1", status: 'PAUSED' })).rejects.toMatchObject({ status: 400 });
    await expect(execute('set_status', { level: 'campaign', object_id: '1', status: 'REMOVED' })).rejects.toMatchObject({ status: 400 });
    await expect(execute('propose_budget_change', { campaign_id: 'x', proposed_budget_ars: 100 })).rejects.toMatchObject({ status: 400 });
    expect(gads.calls).toHaveLength(0);
    expect(gads.searchCount).toBe(0);
  });

  it('presupuesto en pesos → micros', async () => {
    await execute('propose_budget_change', { campaign_id: '101', campaign_name: 'marca', current_budget_ars: 20000, proposed_budget_ars: 45000 });
    expect(gads.queries[0]).toMatch(/campaign\.campaign_budget[\s\S]*WHERE campaign\.id = 101/);
    expect(mutates(gads)).toEqual([['mutate', 'campaignBudgets', [{ update: { resourceName: rn('campaignBudgets', 501), amountMicros: '45000000000' }, updateMask: 'amount_micros' }]]]);
  });

  it('presupuesto compartido o campaña inexistente: error claro sin mutate', async () => {
    await expect(execute('propose_budget_change', { campaign_id: '999', proposed_budget_ars: 1000 })).rejects.toMatchObject({ status: 404 });
    withSearch(gads, (q, rows) => rows.map((r) => ({ ...r, campaignBudget: { ...r.campaignBudget, explicitlyShared: true } })));
    await expect(execute('propose_budget_change', { campaign_id: '101', proposed_budget_ars: 1000 })).rejects.toThrow(/compartido/);
    expect(mutates(gads)).toHaveLength(0);
  });

  it('palabras negativas a nivel campaña', async () => {
    await execute('add_negative_keywords', { level: 'campaign', target_id: '101', keywords: ['gratis', ' Gratis ', 'usado'], match_type: 'PHRASE' });
    expect(mutates(gads)).toEqual([['mutate', 'campaignCriteria', [
      { create: { campaign: rn('campaigns', '101'), negative: true, keyword: { text: 'gratis', matchType: 'PHRASE' } } },
      { create: { campaign: rn('campaigns', '101'), negative: true, keyword: { text: 'usado', matchType: 'PHRASE' } } },
    ]]]);
    await execute('add_negative_keywords', { level: 'ad_group', target_id: '201', keywords: ['mercado libre'], match_type: 'EXACT' });
    expect(mutates(gads)[1]).toEqual(['mutate', 'adGroupCriteria', [{ create: { adGroup: rn('adGroups', '201'), negative: true, keyword: { text: 'mercado libre', matchType: 'EXACT' } } }]]);
    await expect(execute('add_negative_keywords', { level: 'campaign', target_id: '101', keywords: [], match_type: 'PHRASE' })).rejects.toMatchObject({ status: 400 });
  });

  it('anuncio de búsqueda adaptable y objetivo de ROAS', async () => {
    const input = { ad_group_id: '201', headlines: ['Mantas de lana', 'Envío a todo el país', 'Hasta 6 cuotas'], descriptions: ['Mantas tejidas a mano.', 'Comprá online.'], final_url: 'https://altorancho.com/mantas' };
    await execute('propose_search_ad', input);
    expect(mutates(gads)[0]).toEqual(['mutate', 'adGroupAds', [{
      create: {
        adGroup: rn('adGroups', '201'), status: 'ENABLED',
        ad: {
          finalUrls: ['https://altorancho.com/mantas'],
          responsiveSearchAd: { headlines: input.headlines.map((text) => ({ text })), descriptions: input.descriptions.map((text) => ({ text })) },
        },
      },
    }]]);
    await expect(execute('propose_search_ad', { ...input, headlines: [...input.headlines, 'x'.repeat(31)] })).rejects.toMatchObject({ status: 400 });
    await expect(execute('propose_search_ad', { ...input, final_url: 'http://altorancho.com' })).rejects.toMatchObject({ status: 400 });

    await execute('set_target_roas', { campaign_id: '102', current_target_roas: 4.5, proposed_target_roas: 5 });
    expect(mutates(gads)[1]).toEqual(['mutate', 'campaigns', [{
      update: { resourceName: rn('campaigns', '102'), maximizeConversionValue: { targetRoas: 5 } }, updateMask: 'maximize_conversion_value.target_roas',
    }]]);
  });

  it('los errores de Google llegan legibles', async () => {
    gads.mutate = async () => { throw new Error('Google Ads 400: Budget amount is too low.'); };
    await expect(execute('propose_budget_change', { campaign_id: '101', proposed_budget_ars: 1 })).rejects.toThrow('Google Ads 400: Budget amount is too low.');
  });
});

describe('add_assets', () => {
  let gads;
  let execute;
  async function piece({ media = { landscape: rn('assets', 701), square: rn('assets', 702) }, youtube = 'abc123' } = {}) {
    const c = await repo.createCreative({ name: 'Mantas invierno', copy: '', link: 'https://altorancho.com/mantas' });
    await repo.updateCreative(c.id, {
      headlines: JSON.stringify(['Mantas de lana', 'Abrigo para tu casa', 'Envío gratis']),
      long_headline: 'Mantas de lana tejidas a mano para el invierno',
      descriptions: JSON.stringify(['Tejidas a mano en Argentina.', 'Hasta 6 cuotas sin interés.']),
      youtube_url: youtube,
    });
    for (const [slot, assetName] of Object.entries(media)) await repo.setMedia(c.id, slot, { kind: 'image', assetName });
    return c;
  }
  beforeEach(() => {
    gads = fakeGoogleAds();
    execute = createGoogleExecutor({ gads, repo });
  });

  it('add_assets a un grupo de recursos sube textos e imágenes y marca la pieza usada', async () => {
    const c = await piece();
    const out = await execute('add_assets', { creative_id: c.id, target: 'asset_group', target_id: '401', target_name: 'genérica' });
    const [assets, links] = mutates(gads);
    expect(assets[1]).toBe('assets');
    expect(assets[2].map((o) => o.create.textAsset.text)).toEqual([
      'Mantas de lana', 'Abrigo para tu casa', 'Envío gratis', 'Mantas de lana tejidas a mano para el invierno', 'Tejidas a mano en Argentina.', 'Hasta 6 cuotas sin interés.',
    ]);
    expect(gads.calls).toContainEqual(['createYoutubeAsset', 'abc123', 'Mantas invierno - YouTube']);
    expect(links[1]).toBe('assetGroupAssets');
    const group = rn('assetGroups', '401');
    expect(links[2].map((o) => [o.create.assetGroup, o.create.fieldType, o.create.asset])).toEqual([
      [group, 'HEADLINE', rn('assets', '90')], [group, 'HEADLINE', rn('assets', '91')], [group, 'HEADLINE', rn('assets', '92')],
      [group, 'LONG_HEADLINE', rn('assets', '93')], [group, 'DESCRIPTION', rn('assets', '94')], [group, 'DESCRIPTION', rn('assets', '95')],
      [group, 'MARKETING_IMAGE', rn('assets', 701)], [group, 'SQUARE_MARKETING_IMAGE', rn('assets', 702)], [group, 'YOUTUBE_VIDEO', rn('assets', '750')],
    ]);
    expect(out).toMatchObject({ resource: group, linked: 9 });
    const used = await repo.getCreative(c.id);
    expect(used).toMatchObject({ status: 'used', meta_ad_id: group, meta_adset_id: '401' });
    await expect(execute('add_assets', { creative_id: c.id, target: 'asset_group', target_id: '401' })).rejects.toMatchObject({ status: 409 });
  });

  it('una imagen sin subir a Google o un error de Google devuelven la pieza a sin usar', async () => {
    const c = await piece({ media: { portrait: null } });
    await expect(execute('add_assets', { creative_id: c.id, target: 'asset_group', target_id: '401' })).rejects.toThrow(/vertical.*no está subida/);
    expect((await repo.getCreative(c.id)).status).toBe('unused');
    expect(mutates(gads)).toHaveLength(0);

    const ok = await piece();
    gads.mutate = async () => { throw new Error('Google Ads 400: Too many headlines.'); };
    await expect(execute('add_assets', { creative_id: ok.id, target: 'asset_group', target_id: '401' })).rejects.toThrow('Google Ads 400: Too many headlines.');
    expect((await repo.getCreative(ok.id)).status).toBe('unused');
  });

  it('a un grupo de Demand Gen crea un anuncio de imágenes con el logo y el nombre del grupo', async () => {
    const c = await piece();
    const out = await execute('add_assets', { creative_id: c.id, target: 'ad_group', target_id: '202', target_name: 'deco_visitas' });
    const [call] = mutates(gads);
    expect(call[1]).toBe('adGroupAds');
    expect(call[2][0].create).toEqual({
      adGroup: rn('adGroups', '202'), status: 'ENABLED',
      ad: {
        name: 'Mantas invierno', finalUrls: ['https://altorancho.com/mantas'],
        demandGenMultiAssetAd: {
          headlines: [{ text: 'Mantas de lana' }, { text: 'Abrigo para tu casa' }, { text: 'Envío gratis' }],
          descriptions: [{ text: 'Tejidas a mano en Argentina.' }, { text: 'Hasta 6 cuotas sin interés.' }],
          businessName: 'Altorancho', logoImages: [{ asset: rn('assets', '800') }],
          marketingImages: [{ asset: rn('assets', 701) }], squareMarketingImages: [{ asset: rn('assets', 702) }],
        },
      },
    });
    expect(out.resource).toBe(rn('adGroupAds', '90'));
    expect(await repo.getCreative(c.id)).toMatchObject({ status: 'used', meta_ad_id: rn('adGroupAds', '90'), meta_adset_id: '202' });
  });

  it('Demand Gen sin anuncio para copiar el logo: error y la pieza queda sin usar', async () => {
    const c = await piece();
    await expect(execute('add_assets', { creative_id: c.id, target: 'ad_group', target_id: '201' })).rejects.toMatchObject({ status: 409 });
    expect((await repo.getCreative(c.id)).status).toBe('unused');
  });
});

describe('pausa automática de Google', () => {
  const settings = { autonomous: true, auto_pause_min_spend_ars: 5000, auto_pause_days: 7 };
  const pauseKw = { level: 'keyword', object_id: '201~301', object_name: 'mantas de lana', status: 'PAUSED', ...why };
  function setup(gads, purchaseAction = PA) {
    const executed = [];
    const execute = async (tool, input) => { executed.push([tool, input.object_id]); return createGoogleExecutor({ gads, repo })(tool, input); };
    return { executed, dispatch: createGoogleDispatcher({ gads, repo, execute, purchaseAction }) };
  }

  it('pausa automática de palabra clave: ejecuta con gasto ≥ mínimo y 0 compras; en PMax siempre pendiente', async () => {
    const gads = noPurchases(fakeGoogleAds());
    const { dispatch, executed } = setup(gads);
    const res = await dispatch('set_status', pauseKw, { runId: null, settings });
    expect(res).toMatchObject({ executed: true, auto_pause: { spend: 12000, purchases: 0, days: 7, min: 5000 } });
    expect(executed).toEqual([['set_status', '201~301']]);
    expect(gads.calls).toContainEqual(['mutate', 'adGroupCriteria', [{ update: { resourceName: rn('adGroupCriteria', '201~301'), status: 'PAUSED' }, updateMask: 'status' }]]);
    // El período es exactamente auto_pause_days
    expect(gads.queries.some((q) => q.includes("segments.date BETWEEN") && q.includes('metrics.cost_micros') && q.includes('ad_group_criterion.criterion_id = 301'))).toBe(true);
    const [d] = await repo.listDecisions();
    expect(d).toMatchObject({ tool: 'set_status', status: 'executed' });

    // La misma palabra en una campaña Performance Max: pendiente
    const pmax = withSearch(noPurchases(fakeGoogleAds()), (q, rows) => (/FROM campaign/.test(q) ? rows.map((r) => ({ ...r, campaign: { ...r.campaign, advertisingChannelType: 'PERFORMANCE_MAX' } })) : rows));
    const p = setup(pmax);
    const queued = await p.dispatch('set_status', pauseKw, { runId: null, settings });
    expect(queued).toMatchObject({ queued: true });
    expect(queued.note).toMatch(/Performance Max/);
    expect(p.executed).toEqual([]);
    expect(pmax.calls).toEqual([]);
  });

  it('con compras, debajo del mínimo, apagada o sin mínimo: pendiente', async () => {
    const { dispatch, executed } = setup(fakeGoogleAds());
    expect((await dispatch('set_status', pauseKw, { settings })).note).toMatch(/tuvo 3 compras/);
    const low = setup(noPurchases(fakeGoogleAds()));
    expect((await low.dispatch('set_status', pauseKw, { settings: { ...settings, auto_pause_min_spend_ars: 20000 } })).note).toMatch(/no llega al mínimo/);
    expect((await low.dispatch('set_status', pauseKw, { settings: { ...settings, auto_pause_min_spend_ars: 0 } })).note).toMatch(/sin mínimo/);
    expect((await low.dispatch('set_status', pauseKw, { settings: { ...settings, autonomous: false } })).note).toMatch(/pendiente/);
    expect([...executed, ...low.executed]).toEqual([]);
  });

  it('grupo de anuncios de Search se pausa solo; uno de Demand Gen de tráfico no', async () => {
    const gads = noPurchases(fakeGoogleAds());
    const { dispatch, executed } = setup(gads);
    expect(await dispatch('set_status', { level: 'ad_group', object_id: '201', status: 'PAUSED', ...why }, { settings })).toMatchObject({ executed: true, auto_pause: { spend: 14000 } });
    expect((await dispatch('set_status', { level: 'ad_group', object_id: '202', status: 'PAUSED', ...why }, { settings })).note).toMatch(/Demand Gen/);
    expect(executed).toEqual([['set_status', '201']]);
  });

  it('id inválido u objeto desconocido: pendiente sin seguir consultando; campañas siempre pendientes', async () => {
    const gads = noPurchases(fakeGoogleAds());
    const { dispatch, executed } = setup(gads);
    expect((await dispatch('set_status', { ...pauseKw, object_id: '301' }, { settings })).note).toMatch(/no es válido/);
    expect(gads.searchCount).toBe(0);
    expect((await dispatch('set_status', { ...pauseKw, object_id: '999~1' }, { settings })).note).toMatch(/no encontré/);
    expect(gads.searchCount).toBe(1);
    expect(await dispatch('set_status', { level: 'campaign', object_id: '102', status: 'PAUSED', ...why }, { settings })).toMatchObject({ queued: true });
    expect(gads.searchCount).toBe(1);
    expect(executed).toEqual([]);
  });

  it('palabra de marca o sin acción de compra: pendiente', async () => {
    const brand = withSearch(noPurchases(fakeGoogleAds()), (q, rows) => rows.map((r) => (r.adGroupCriterion?.keyword ? { ...r, adGroupCriterion: { ...r.adGroupCriterion, keyword: { text: 'alto rancho muebles' } } } : r)));
    expect((await setup(brand).dispatch('set_status', pauseKw, { settings })).note).toMatch(/marca/);
    const noPa = noPurchases(fakeGoogleAds());
    expect((await setup(noPa, null).dispatch('set_status', pauseKw, { settings })).note).toMatch(/acción de compra/);
    expect(noPa.queries.some((q) => q.includes('metrics.cost_micros'))).toBe(false);
    expect([...brand.calls, ...noPa.calls]).toEqual([]);
  });

  it('si Google no responde, no pausa', async () => {
    const gads = fakeGoogleAds();
    gads.search = async () => { throw new Error('Google Ads 503: unavailable'); };
    const { dispatch, executed } = setup(gads);
    expect((await dispatch('set_status', pauseKw, { settings })).note).toMatch(/no pude verificar.*503/);
    expect(executed).toEqual([]);
  });

  it('el resto queda pendiente y las de equipo se atienden', async () => {
    const gads = fakeGoogleAds();
    const { dispatch } = setup(gads);
    expect(await dispatch('set_target_roas', { campaign_id: '102', proposed_target_roas: 5, ...why }, { settings })).toMatchObject({ queued: true });
    expect(await dispatch('ask_team', { question: '¿Hay stock?', why: 'presupuesto' }, { settings })).toMatchObject({ ok: true });
    expect(await dispatch('pause_ad', { ad_id: '1' }, { settings })).toMatchObject({ error: expect.stringMatching(/desconocida/) });
    expect(gads.calls).toEqual([]);
  });
});

describe('contexto del agente de Google', () => {
  const NOW = new Date('2026-10-21T15:00:00Z');
  const m = (spend) => ({ spend, clicks: 0, ctr: null, cpc: null, landingPageViews: 0, costPerLandingPageView: null });

  it('recorta pausados sin gasto, limita palabras clave y saca métricas de Meta', () => {
    const campaigns = [
      { id: '1', status: 'ENABLED', channelType: 'SEARCH', family: 'traffic', platform7d: m(100), platformPrev7d: m(0) },
      { id: '2', status: 'PAUSED', channelType: 'SEARCH', family: 'traffic', platform7d: m(0), platformPrev7d: m(0) },
      { id: '3', status: 'PAUSED', channelType: 'SEARCH', family: 'traffic', platform7d: m(0), platformPrev7d: m(50) },
      { id: '4', status: 'ENABLED', channelType: 'PERFORMANCE_MAX', family: 'sales', platform7d: { spend: 1 }, platformPrev7d: { spend: 1 } },
      { id: '5', status: 'PAUSED', channelType: 'PERFORMANCE_MAX', family: 'sales', platform7d: { spend: 9 }, platformPrev7d: { spend: 0 } },
    ];
    const adGroups = [
      { id: '10', campaignId: '1', status: 'ENABLED', platform7d: m(0) },
      { id: '11', campaignId: '1', status: 'PAUSED', platform7d: m(0) },
      { id: '12', campaignId: '2', status: 'ENABLED', platform7d: m(0) },
    ];
    const keywords = Array.from({ length: 200 }, (_, i) => ({ id: `10~${i}`, text: `kw ${i}`, adGroupId: '10', campaignId: '1', status: 'ENABLED', platform7d: m(1000 - i) }));
    keywords.push({ id: '10~900', text: 'Alto Rancho', adGroupId: '10', campaignId: '1', status: 'ENABLED', platform7d: m(0) });
    keywords.push({ id: '10~901', text: 'altorancho sillones', adGroupId: '10', campaignId: '1', status: 'PAUSED', platform7d: m(0) });
    keywords.push({ id: '12~1', text: 'en campaña pausada', adGroupId: '12', campaignId: '2', status: 'ENABLED', platform7d: m(0) });
    const assetGroups = [{ id: '40', campaignId: '4', status: 'ENABLED' }, { id: '41', campaignId: '5', status: 'ENABLED' }];
    const t = trimGoogleForAgent({ campaigns, adGroups, keywords, assetGroups, searchTerms: [] });
    expect(t.campaigns.map((c) => c.id)).toEqual(['1', '3', '4', '5']);
    expect(t.adGroups.map((g) => g.id)).toEqual(['10']);
    expect(t.keywords).toHaveLength(MAX_KEYWORDS + 1);
    expect(t.keywords.map((k) => k.id)).toContain('10~900');
    expect(t.keywords.map((k) => k.id)).not.toContain('10~901');
    expect(t.keywords.map((k) => k.id)).not.toContain('10~199');
    expect(t.campaigns[0].platform7d).not.toHaveProperty('landingPageViews');
    expect(t.keywords[0].platform7d).not.toHaveProperty('costPerLandingPageView');
    expect(t.assetGroups.map((a) => a.id)).toEqual(['40']);
    expect(t.omitted).toEqual({ campaigns: 1, adGroups: 2, keywords: 52, assetGroups: 1 });
  });

  it('arma las secciones con la acción de compra; sin acción lo dice; con ajuste inexistente avisa', async () => {
    const gads = fakeGoogleAds();
    const settings = { ...(await repo.getSettings()), monthly_cap_ars: 900000 };
    const text = await buildGoogleContext({ gads, repo, settings, now: NOW });
    for (const name of ['today', 'settings', 'purchaseAction', 'account', 'campaigns', 'adGroups', 'keywords', 'searchTerms', 'assetGroups', 'unusedCreatives',
      'openCreativeRequests', 'activeLearnings', 'pendingRecommendations', 'recentDecisions', 'decisionsToEvaluate', 'openQuestions', 'answeredQuestions']) {
      expect(() => contextSection(text, name)).not.toThrow();
    }
    expect(contextSection(text, 'purchaseAction')).toMatchObject({ name: 'ALTORANCHO - GA4 (web) purchase', auto: true });
    expect(contextSection(text, 'commercialCalendar')).toContainEqual(expect.objectContaining({ name: 'CyberMonday (CACE)', phase: 'antes' }));
    expect(contextSection(text, 'settings')).toMatchObject({ monthly_cap_ars: 900000, auto_pause_days: 7 });
    expect(contextSection(text, 'campaigns').find((c) => c.family === 'traffic').platform7d).not.toHaveProperty('landingPageViews');
    expect(contextSection(text, 'assetGroups')).toEqual([{ id: '401', name: 'genérica', campaignId: '102', status: 'ENABLED' }]);

    const missing = await buildGoogleContext({ gads, repo, settings: { ...settings, purchase_action: '999' }, now: NOW });
    expect(contextSection(missing, 'purchaseAction')).toMatchObject({ overrideMissing: true, note: expect.stringMatching(/ask_team/) });

    const none = withSearch(fakeGoogleAds(), (q, rows) => (/FROM conversion_action/.test(q) ? [] : rows));
    const noneText = await buildGoogleContext({ gads: none, repo, settings, now: NOW });
    expect(contextSection(noneText, 'purchaseAction')).toMatchObject({ missing: true });
  });

  it('el agente de Google corre con su prompt y sus herramientas, y deja recomendaciones', async () => {
    await repo.updateSettings({ agent_enabled: true });
    const anthropic = fakeAnthropic([
      toolTurn(['add_negative_keywords', { level: 'campaign', target_id: '101', keywords: ['gratis'], match_type: 'PHRASE', ...why }]),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Cómo vamos** bien' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    fakeAnthropic.firstMessage = undefined;
    const gads = fakeGoogleAds();
    const start = createGoogleAgentRunner({ anthropic, gads, repo, execute: createGoogleExecutor({ gads, repo }), log: { error: () => {} } });
    const { done } = await start('manual');
    const run = await done;
    expect(run).toMatchObject({ status: 'done', report: '**Cómo vamos** bien', platform: 'google' });
    expect(fakeAnthropic.lastParams.system).toBe(GOOGLE_SYSTEM_PROMPT);
    expect(fakeAnthropic.lastParams.tools.map((t) => t.name)).toContain('add_assets');
    expect(fakeAnthropic.firstMessage).toMatch(/cuenta de Google Ads/);
    const [d] = await repo.listDecisions();
    expect(d).toMatchObject({ tool: 'add_negative_keywords', status: 'pending', platform: 'google' });
    expect(gads.calls).toEqual([]);
  });
});
