import { commercialCalendarFor } from './commercialCalendar.js';
import { TOOL_DEFINITIONS, READ_ONLY_TOOLS, META_ACTIONS } from './tools.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { buildSnapshot } from './snapshot.js';
import { buildAdName, buildLinkCreativeSpec, buildIgPostCreativeSpec, IG_ACCESS_MSG } from './creativeSpec.js';
import { loadIgPosts } from './igPosts.js';
import { artDate, addDays } from '../engine/dates.js';
import { metaFamily } from './families.js';
import { checkAutoPause } from './autoPause.js';
import { summarizeMetaRow } from './metrics.js';
import { handleTeamTool } from './teamTools.js';
import { createAgentRunner, DEFAULT_MODEL } from './runner.js';

export { DEFAULT_MODEL };

// Página e Instagram con nombres propios (META_ADS_*): las META_PAGE_ID/META_IG_ACTOR_ID viejas eran de otra cuenta.
// Si no están, se descubren desde la cuenta publicitaria (promote_pages).
export function adsConfigFromEnv(env = process.env) {
  return {
    pageId: env.META_ADS_PAGE_ID || null,
    igUserId: env.META_ADS_IG_USER_ID || null,
    // Solo hace falta si se crea un conjunto en una campaña que todavía no tiene ninguno para copiar
    pixelId: env.META_ADS_PIXEL_ID || null,
    storeUrl: (env.STORE_URL || 'https://altorancho.com').replace(/\/+$/, ''),
  };
}

export function createIdentity({ meta, config }) {
  let pending = null;
  return async function identity() {
    if (config.pageId && config.igUserId) return { pageId: config.pageId, igUserId: config.igUserId };
    pending ??= meta.discoverIdentity().catch((err) => {
      pending = null;
      throw err;
    });
    const found = await pending;
    const pageId = config.pageId || found.pageId;
    if (!pageId) throw new Error('No encontré la página de Facebook de la cuenta publicitaria: cargá META_ADS_PAGE_ID.');
    return { pageId, igUserId: config.igUserId || found.igUserId };
  };
}

export const isStoreLink = (v) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) && v.length <= 1000;

// Ejecuta una acción sobre Meta (al aprobarla en el panel, o sola en modo autónomo)
export function createExecutor({ meta, repo, config, identity }) {
  // La pieza se reclama antes de tocar Meta (puede tardar minutos con video): un segundo "Publicar" recibe 409
  async function publishCreative({ creative_id: creativeId, adset_id: adsetId, adset_name: adsetName }) {
    const creative = await repo.claimCreative(creativeId);
    try {
      return await publishClaimed(creative, adsetId, adsetName);
    } catch (err) {
      await repo.releaseCreative(creativeId);
      throw err;
    }
  }

  async function publishClaimed(creative, adsetId, adsetName) {
    if (!creative.feed) throw new Error(`La pieza "${creative.name}" no tiene imagen ni video de feed.`);
    // Las piezas ya están en la biblioteca de Meta: imagen = hash; video = esperar que esté procesado
    const toMeta = async (m) => {
      if (m.kind === 'image') return { type: 'image', hash: m.image_hash };
      await meta.waitVideoReady(m.video_id);
      return { type: 'video', videoId: m.video_id, thumbnailUrl: m.thumbnail_url || await meta.videoThumbnail(m.video_id) };
    };
    const [feed, story] = await Promise.all([toMeta(creative.feed), creative.story ? toMeta(creative.story) : null]);
    const { pageId, igUserId } = await identity();
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: creative.name, date: artDate() });
    const publish = async (ig) => {
      const spec = buildLinkCreativeSpec({
        name, pageId, igUserId: ig, message: creative.copy, headline: creative.headline, link: creative.link, feed, story,
      });
      const { id: metaCreativeId } = await meta.createCreative(spec);
      return meta.createAd({ name, adsetId, creativeId: metaCreativeId, status: 'ACTIVE' });
    };
    let ad;
    try {
      ad = await publish(igUserId);
    } catch (err) {
      // Sin acceso a la cuenta de Instagram, Meta usa la cuenta "de la página": en IG sale con el nombre y la foto de la página
      if (!igUserId || !/instagram/i.test(err.message)) throw err;
      console.warn('[ads] sin acceso a la cuenta de Instagram, publico con la de la página:', err.message);
      ad = await publish(null);
    }
    await repo.markCreativeUsed(creative.id, ad.id, adsetId);
    return { ad_id: ad.id, name };
  }

  async function promoteIgPost({ ig_media_id: mediaId, adset_id: adsetId, adset_name: adsetName, permalink, link }) {
    const target = isStoreLink(link) ? link : config.storeUrl;
    const { pageId, igUserId } = await identity();
    if (!igUserId) throw new Error(IG_ACCESS_MSG);
    // Se reserva antes de tocar Meta: dos pedidos a la vez del mismo post y conjunto no crean dos anuncios
    const reservation = await repo.reserveIgPromotion({ igMediaId: mediaId, permalink, adsetId, adsetName });
    const name = buildAdName({ adsetName: adsetName || adsetId, creativeName: `IG${mediaId.slice(-6)}`, date: artDate() });
    let ad;
    try {
      let creative;
      try {
        creative = await meta.createCreative(buildIgPostCreativeSpec({ name, pageId, igUserId, mediaId, link: target }));
      } catch (err) {
        // Acá no hay respaldo con la cuenta de la página: el post existe solo en la cuenta de Instagram
        if (/instagram/i.test(err.message)) throw new Error(`${IG_ACCESS_MSG} (${err.message})`);
        throw err;
      }
      ad = await meta.createAd({ name, adsetId, creativeId: creative.id, status: 'ACTIVE' });
    } catch (err) {
      await repo.releaseIgPromotion(reservation.id);
      throw err;
    }
    await repo.completeIgPromotion(reservation.id, ad.id);
    return { ad_id: ad.id, name };
  }

  // El conjunto nuevo optimiza igual que los que ya tiene la campaña (píxel y evento de compra);
  // si no hay ninguno para copiar, usa el píxel de META_ADS_PIXEL_ID
  async function deliveryFor(campaignId) {
    const ref = (await meta.getAdsets()).find((a) => a.campaign_id === campaignId && a.promoted_object);
    if (ref) {
      return {
        optimization_goal: ref.optimization_goal, billing_event: ref.billing_event || 'IMPRESSIONS', promoted_object: ref.promoted_object,
        ...(ref.destination_type ? { destination_type: ref.destination_type } : {}),
      };
    }
    if (!config.pixelId) throw new Error('La campaña no tiene conjuntos de referencia y no está cargado META_ADS_PIXEL_ID: no sé con qué píxel optimizar.');
    return { optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', promoted_object: { pixel_id: config.pixelId, custom_event_type: 'PURCHASE' } };
  }

  return async function execute(tool, input) {
    switch (tool) {
      case 'pause_ad':
        await meta.setStatus(input.ad_id, 'PAUSED');
        return { paused: input.ad_id };
      case 'set_status':
        await meta.setStatus(input.object_id, input.status);
        return { [input.object_id]: input.status };
      case 'propose_budget_change':
        await meta.setDailyBudget(input.object_id, input.proposed_budget_ars);
        return { [input.object_id]: input.proposed_budget_ars };
      case 'propose_adset': {
        const targeting = { ...input.targeting };
        if (!targeting.targeting_automation) targeting.targeting_automation = { advantage_audience: 0 };
        const adset = await meta.createAdset({
          campaign_id: input.campaign_id, name: input.name, status: 'PAUSED', targeting,
          ...await deliveryFor(input.campaign_id),
          ...(input.daily_budget_ars ? { daily_budget: Math.round(input.daily_budget_ars * 100) } : {}),
        });
        if (!input.creative_id) return { adset_id: adset.id };
        const ad = await publishCreative({ creative_id: input.creative_id, adset_id: adset.id, adset_name: input.name });
        return { adset_id: adset.id, ...ad };
      }
      case 'create_ad':
        return publishCreative(input);
      case 'promote_ig_post':
        return promoteIgPost(input);
      default:
        throw new Error(`Acción desconocida: ${tool}`);
    }
  };
}

// Atiende cada tool_use del modelo durante una corrida
export function createDispatcher({ meta, repo, execute }) {
  async function verifyAutoPause(adId, settings) {
    const days = settings.auto_pause_days ?? 7;
    const min = Number(settings.auto_pause_min_spend_ars) || 0;
    try {
      if (!/^\d+$/.test(String(adId ?? ''))) return { ok: false, reason: 'el id del anuncio no es válido' };
      const [ad] = await meta.getByIds('ad', [adId]);
      const [campaign] = ad?.campaign_id ? await meta.getByIds('campaign', [ad.campaign_id]) : [];
      if (!campaign) return { ok: false, reason: 'no encontré el anuncio o su campaña en Meta' };
      const family = metaFamily(campaign.objective);
      const today = artDate();
      const row = await meta.getObjectInsights(adId, addDays(today, -(days - 1)), today);
      const spend = Number(row.spend ?? 0);
      const purchases = summarizeMetaRow(row).metaPurchases;
      const check = checkAutoPause({ settings, family, spend, purchases });
      return { ...check, data: { spend, purchases, days, min } };
    } catch (err) {
      // Sin poder medir no se pausa solo
      return { ok: false, reason: `no pude verificar el gasto en Meta (${String(err.message || err)})` };
    }
  }

  return async function dispatch(name, input, { runId, settings }) {
    const base = { runId, tool: name, input, title: input.title ?? '', reason: input.reason ?? '', expectedImpact: input.expected_impact ?? '' };
    try {
      if (name === 'search_interest') return { results: await meta.searchInterests(input.query) };
      const team = await handleTeamTool(name, input, { repo, runId });
      if (team !== undefined) return team;
      if (!META_ACTIONS.has(name)) return { error: `Herramienta desconocida: ${name}` };

      if (name === 'pause_ad' && settings.autonomous) {
        // Umbral duro: el código vuelve a medir el anuncio en Meta; el modelo no decide si se cumple
        const check = await verifyAutoPause(input.ad_id, settings);
        if (check.ok) {
          const result = { ...await execute(name, input), auto_pause: check.data };
          await repo.addDecision({ ...base, status: 'executed', result });
          return { ok: true, executed: true, ...result };
        }
        const d = await repo.addDecision({ ...base, status: 'pending' });
        return { queued: true, decision_id: d.id, note: `No se pausó solo: ${check.reason}. Quedó para aprobar.` };
      }
      const d = await repo.addDecision({ ...base, status: 'pending' });
      return { queued: true, decision_id: d.id, note: 'Quedó pendiente de aprobación en el panel.' };
    } catch (err) {
      if (!READ_ONLY_TOOLS.has(name)) await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      return { error: String(err.message || err) };
    }
  };
}

async function igPostsForContext({ meta, repo, identity }) {
  try {
    const { igUserId } = await identity();
    if (!igUserId) return { error: 'La cuenta publicitaria no tiene una cuenta de Instagram vinculada.' };
    const posts = await loadIgPosts({ meta, repo, igUserId });
    return posts.map((p) => ({
      id: p.id, type: p.type, caption: p.caption.slice(0, 300), timestamp: p.timestamp, permalink: p.permalink,
      likes: p.likes, comments: p.comments, reach: p.reach, promotedIn: p.promotedIn.map((x) => x.adset_name || x.adset_id),
    }));
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

const mediaKind = (m) => (m ? m.kind : null);

// La cuenta acumula años de anuncios pausados (con copy y segmentación cada uno): mandarlos todos pasaba el
// millón de tokens. Al agente le llega lo prendido y lo que gastó o vendió en las últimas dos semanas.
const OFF = new Set(['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);
export const MAX_CONTEXT_CHARS = 1_500_000; // ~400 mil tokens: más que eso es un error, no un análisis
const moved = (o) => Boolean(o.platform7d?.spend || o.store7d?.sales || o.platformPrev7d?.spend);
const relevant = (o) => !OFF.has(o.effectiveStatus) || moved(o);

export function trimForAgent(snapshot) {
  // last7d/prev7d son alias para el panel. De delivery7d solo van las señales de entrega (fatiga), no las compras de Meta
  const lean = ({ last7d, prev7d, storePrev7d, delivery7d, ...o }) => (delivery7d
    ? { ...o, delivery7d: { frequency: delivery7d.frequency, ctr: delivery7d.ctr, cpm: delivery7d.cpm } }
    : o);
  const ads = snapshot.ads.filter(relevant).map(({ thumbnail, ...a }) => lean({ ...a, copy: a.copy ? a.copy.slice(0, 400) : a.copy }));
  const adsetsWithAds = new Set(ads.map((a) => a.adsetId));
  const adsets = snapshot.adsets.filter((a) => relevant(a) || adsetsWithAds.has(a.id)).map(lean);
  const adsetCampaigns = new Set(adsets.map((a) => a.campaignId));
  const campaigns = snapshot.campaigns.filter((c) => relevant(c) || adsetCampaigns.has(c.id)).map(lean);
  const omitted = {
    campaigns: snapshot.campaigns.length - campaigns.length,
    adsets: snapshot.adsets.length - adsets.length,
    ads: snapshot.ads.length - ads.length,
  };
  return { campaigns, adsets, ads, omitted };
}

export async function buildContext({ meta, reports, repo, identity }) {
  const [snapshot, settings, unusedCreatives, openRequests, learnings, pending, recent, toEvaluate, openQuestions, answeredQuestions, igPosts] = await Promise.all([
    buildSnapshot({ meta, reports }),
    repo.getSettings(),
    repo.listCreatives({ status: 'unused' }),
    repo.listRequests({ status: 'open' }),
    repo.listLearnings({ activeOnly: true }),
    repo.listDecisions({ status: 'pending', limit: 30 }),
    repo.listDecisions({ limit: 30 }),
    repo.executedWithoutOutcome(48),
    repo.listQuestions({ status: 'open', limit: 30 }),
    repo.answeredSinceLastRun(),
    igPostsForContext({ meta, repo, identity }),
  ]);
  const structure = trimForAgent(snapshot);
  const sections = {
    today: snapshot.today,
    commercialCalendar: commercialCalendarFor(snapshot.today),
    settings: {
      monthly_cap_ars: settings.monthly_cap_ars, autonomous: settings.autonomous, auto_pause_min_spend_ars: settings.auto_pause_min_spend_ars,
      auto_pause_days: settings.auto_pause_days, business_notes: settings.business_notes,
    },
    spendThisMonth: snapshot.month.spend,
    account: { spendToday: snapshot.spendToday, month: snapshot.month, store7d: snapshot.last7d },
    // Pausados sin gasto ni ventas en 14 días: no se mandan, solo se cuentan
    omittedPausedWithoutActivity: structure.omitted,
    campaigns: structure.campaigns,
    adsets: structure.adsets,
    ads: structure.ads,
    unusedCreatives: unusedCreatives.map((c) => ({
      id: c.id, name: c.name, copy: c.copy, headline: c.headline, link: c.link, notes: c.notes, feed: mediaKind(c.feed), story: mediaKind(c.story),
    })),
    igPosts,
    openCreativeRequests: openRequests.map((r) => ({ concept: r.concept, created_at: r.created_at })),
    activeLearnings: learnings.map((l) => ({ id: l.id, text: l.text, evidence: l.evidence })),
    pendingRecommendations: pending.map((d) => ({ id: d.id, tool: d.tool, title: d.title, created_at: d.created_at })),
    recentDecisions: recent.filter((d) => d.status !== 'pending').map((d) => ({ id: d.id, tool: d.tool, title: d.title, status: d.status, outcome: d.outcome, created_at: d.created_at })),
    decisionsToEvaluate: toEvaluate,
    openQuestions: openQuestions.map((q) => ({ id: q.id, question: q.question, created_at: q.created_at })),
    answeredQuestions: answeredQuestions.map((q) => ({ question: q.question, answer: q.answer, answered_at: q.answered_at })),
  };
  const text = Object.entries(sections).map(([k, v]) => `## ${k}\n${JSON.stringify(v)}`).join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    const sizes = Object.entries(sections).map(([k, v]) => `${k} ${Math.round(JSON.stringify(v).length / 1000)}k`).join(', ');
    throw new Error(`Los datos para el agente son demasiado grandes (${Math.round(text.length / 1000)}k caracteres: ${sizes}); no se mandó nada a Claude.`);
  }
  return text;
}

// Corrida del agente de Meta: contexto con la foto de la cuenta y ventas de la tienda, herramientas de Meta + equipo
export function createMetaAgentRunner({ anthropic, meta, reports, repo, execute, identity, model = DEFAULT_MODEL, log = console }) {
  return createAgentRunner({
    anthropic, repo, model, log,
    buildContext: () => buildContext({ meta, reports, repo, identity }),
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS,
    dispatch: createDispatcher({ meta, repo, execute }),
    platformLabel: 'Meta',
  });
}
