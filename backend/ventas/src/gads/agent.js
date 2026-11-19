import { GOOGLE_TOOL_DEFINITIONS, GOOGLE_ACTIONS } from './tools.js';
import { GOOGLE_SYSTEM_PROMPT } from './systemPrompt.js';
import { buildGoogleSnapshot, lit, between, pesos, num } from './snapshot.js';
import { resolvePurchaseAction } from './purchaseAction.js';
import { KEYWORD_ID, NUMERIC_ID } from './executor.js';
import { artDate, addDays } from '../engine/dates.js';
import { googleFamily } from '../ads/families.js';
import { checkAutoPause } from '../ads/autoPause.js';
import { handleTeamTool } from '../ads/teamTools.js';
import { commercialCalendarFor } from '../ads/commercialCalendar.js';
import { createAgentRunner, DEFAULT_MODEL } from '../ads/runner.js';
import { MAX_CONTEXT_CHARS } from '../ads/agent.js';

const CHANNEL_LABEL = { PERFORMANCE_MAX: 'Performance Max', DEMAND_GEN: 'Demand Gen', DISPLAY: 'Display', VIDEO: 'Video', SHOPPING: 'Shopping' };

// Palabras de marca: nunca se pausan solas
export const isBrandKeyword = (text) => /alto ?rancho/i.test(String(text ?? ''));

// La acción de compra puede venir fija, como función de los ajustes, o resolverse en el momento
async function purchaseActionFor(source, gads, settings) {
  if (typeof source === 'function') return source(settings);
  if (source !== undefined) return source;
  return resolvePurchaseAction(gads, settings);
}

// Atiende cada tool_use del modelo durante una corrida
export function createGoogleDispatcher({ gads, repo, execute, purchaseAction }) {
  // Vuelve a medir en Google la palabra clave o el grupo: el modelo no decide si se cumple el umbral
  async function verifyAutoPause(level, objectId, settings) {
    const days = Number(settings.auto_pause_days) || 7;
    const min = Number(settings.auto_pause_min_spend_ars) || 0;
    try {
      const id = String(objectId ?? '').trim();
      let from;
      let where;
      if (level === 'keyword') {
        if (!KEYWORD_ID.test(id)) return { ok: false, reason: 'el id de la palabra clave no es válido' };
        const [adGroupId, criterionId] = id.split('~');
        from = 'keyword_view';
        where = `ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${criterionId}`;
      } else {
        if (!NUMERIC_ID.test(id)) return { ok: false, reason: 'el id del grupo de anuncios no es válido' };
        from = 'ad_group';
        where = `ad_group.id = ${id}`;
      }

      const objectRows = await gads.search(level === 'keyword'
        ? `SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.status
FROM keyword_view
WHERE ${where}`
        : `SELECT campaign.id, ad_group.id, ad_group.status
FROM ad_group
WHERE ${where}`);
      const object = objectRows.find((r) => (level === 'keyword' ? r.adGroupCriterion?.status !== 'REMOVED' : r.adGroup?.status !== 'REMOVED'));
      const campaignId = object?.campaign?.id != null ? String(object.campaign.id) : null;
      if (!campaignId || !NUMERIC_ID.test(campaignId)) return { ok: false, reason: 'no encontré ese objeto o su campaña en Google Ads' };
      const [campaign] = (await gads.search(`SELECT campaign.id, campaign.advertising_channel_type, campaign.bidding_strategy_type
FROM campaign
WHERE campaign.id = ${campaignId}`)).filter((r) => String(r.campaign?.id) === campaignId);
      if (!campaign) return { ok: false, reason: 'no encontré la campaña en Google Ads' };

      const channel = campaign.campaign.advertisingChannelType;
      const family = googleFamily({ advertisingChannelType: channel, biddingStrategyType: campaign.campaign.biddingStrategyType });
      // Performance Max y Demand Gen siempre se aprueban a mano
      if (channel !== 'SEARCH') return { ok: false, reason: `la campaña es ${CHANNEL_LABEL[channel] ?? channel}: solo se pausa sola en Search` };
      if (family !== 'sales') return { ok: false, reason: 'no es una campaña de ventas' };
      if (level === 'keyword' && isBrandKeyword(object.adGroupCriterion?.keyword?.text)) {
        return { ok: false, reason: 'es una palabra de marca: se pausa solo con aprobación del equipo' };
      }
      const pa = await purchaseActionFor(purchaseAction, gads, settings);
      if (!pa?.resourceName) return { ok: false, reason: 'no hay acción de compra elegida en Google: no puedo contar compras' };

      const today = artDate();
      const range = between(addDays(today, -(days - 1)), today);
      const [costRows, purchaseRows] = await Promise.all([
        gads.search(`SELECT ad_group.id, metrics.cost_micros
FROM ${from}
WHERE ${where} AND ${range}`),
        gads.search(`SELECT ad_group.id, segments.conversion_action, metrics.all_conversions
FROM ${from}
WHERE ${where} AND ${range} AND segments.conversion_action = ${lit(pa.resourceName)}`),
      ]);
      const spend = pesos(costRows.reduce((s, r) => s + num(r.metrics?.costMicros), 0));
      const purchases = Math.round(purchaseRows.reduce((s, r) => s + num(r.metrics?.allConversions), 0) * 100) / 100;
      const check = checkAutoPause({ settings, family, spend, purchases });
      return { ...check, data: { spend, purchases, days, min } };
    } catch (err) {
      // Sin poder medir no se pausa solo
      return { ok: false, reason: `no pude verificar el gasto en Google (${String(err.message || err)})` };
    }
  }

  return async function dispatch(name, input, { runId, settings }) {
    const base = { runId, tool: name, input, title: input.title ?? '', reason: input.reason ?? '', expectedImpact: input.expected_impact ?? '' };
    try {
      const team = await handleTeamTool(name, input, { repo, runId });
      if (team !== undefined) return team;
      if (!GOOGLE_ACTIONS.has(name)) return { error: `Herramienta desconocida: ${name}` };

      const autoPausable = name === 'set_status' && input.status === 'PAUSED' && (input.level === 'keyword' || input.level === 'ad_group');
      if (autoPausable && settings.autonomous) {
        const check = await verifyAutoPause(input.level, input.object_id, settings);
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
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      return { error: String(err.message || err) };
    }
  };
}

// --- Contexto ---

// La cuenta real tiene ~800 palabras clave, ~90 grupos, ~150 grupos de recursos y muchas campañas pausadas sin datos:
// al agente le llega lo prendido o con gasto, las palabras que más gastan y todas las de marca.
export const MAX_KEYWORDS = 150;
const spent = (o) => Boolean(o.platform7d?.spend || o.platformPrev7d?.spend);
// landingPageViews es de Meta: en Google siempre da 0
function leanMetrics(m) {
  if (!m) return m;
  const { landingPageViews, costPerLandingPageView, ...rest } = m;
  return rest;
}
const lean = (o) => ({
  ...o,
  ...(o.platform7d ? { platform7d: leanMetrics(o.platform7d) } : {}),
  ...(o.platformPrev7d ? { platformPrev7d: leanMetrics(o.platformPrev7d) } : {}),
});

export function trimGoogleForAgent(snapshot) {
  const campaigns = snapshot.campaigns.filter((c) => c.status !== 'PAUSED' || spent(c));
  const keptCampaigns = new Set(campaigns.map((c) => c.id));
  const adGroups = snapshot.adGroups.filter((g) => keptCampaigns.has(g.campaignId) && (g.status !== 'PAUSED' || spent(g)));
  const keptAdGroups = new Set(adGroups.map((g) => g.id));
  // En la foto las palabras pausadas ya están solo si gastaron en 14 días; acá se cortan las que más gastaron + marca
  const candidates = snapshot.keywords
    .filter((k) => keptCampaigns.has(k.campaignId) && keptAdGroups.has(k.adGroupId))
    .sort((a, b) => (b.platform7d?.spend || 0) - (a.platform7d?.spend || 0));
  const top = new Set(candidates.slice(0, MAX_KEYWORDS));
  const keywords = candidates.filter((k) => top.has(k) || (k.status === 'ENABLED' && isBrandKeyword(k.text)));
  const pmax = new Set(snapshot.campaigns.filter((c) => c.status === 'ENABLED' && c.channelType === 'PERFORMANCE_MAX').map((c) => c.id));
  const assetGroups = snapshot.assetGroups.filter((a) => pmax.has(a.campaignId));
  const omitted = {
    campaigns: snapshot.campaigns.length - campaigns.length,
    adGroups: snapshot.adGroups.length - adGroups.length,
    keywords: snapshot.keywords.length - keywords.length,
    assetGroups: snapshot.assetGroups.length - assetGroups.length,
  };
  return {
    campaigns: campaigns.map(lean), adGroups: adGroups.map(lean), keywords: keywords.map(lean), assetGroups, searchTerms: snapshot.searchTerms, omitted,
  };
}

function purchaseActionSection(pa) {
  if (!pa) {
    return { missing: true, note: 'No hay ninguna acción de conversión de compra activa en Google: las compras salen en 0. Preguntale al equipo (ask_team) antes de juzgar campañas de ventas.' };
  }
  return {
    name: pa.name, resourceName: pa.resourceName, auto: pa.auto,
    ...(pa.overrideMissing ? { overrideMissing: true, note: 'La acción de compra elegida en Ajustes ya no existe o no está activa: se usó la automática. Avisale al equipo (ask_team) antes de juzgar ventas.' } : {}),
  };
}

// Lo que pidió cada decisión (ids, montos), sin los textos: alcanza para no repetir y para el límite de cambios de ROAS
const decisionInput = (input) => {
  if (!input || typeof input !== 'object') return input;
  const { title, reason, expected_impact: expectedImpact, ...rest } = input;
  return rest;
};

const images = (c) => ['landscape', 'square', 'portrait'].filter((slot) => c[slot]);
const list = (v) => (Array.isArray(v) ? v : []);

export async function buildGoogleContext({ gads, repo, settings, now = new Date() }) {
  const s = settings ?? await repo.getSettings();
  const purchaseAction = await resolvePurchaseAction(gads, s);
  const [snapshot, unusedCreatives, openRequests, learnings, pending, recent, toEvaluate, openQuestions, answeredQuestions] = await Promise.all([
    buildGoogleSnapshot({ gads, purchaseAction, now }),
    repo.listCreatives({ status: 'unused' }),
    repo.listRequests({ status: 'open' }),
    repo.listLearnings({ activeOnly: true }),
    repo.listDecisions({ status: 'pending', limit: 30 }),
    repo.listDecisions({ limit: 30 }),
    repo.executedWithoutOutcome(48),
    repo.listQuestions({ status: 'open', limit: 30 }),
    repo.answeredSinceLastRun(),
  ]);
  const structure = trimGoogleForAgent(snapshot);
  const sections = {
    today: snapshot.today,
    commercialCalendar: commercialCalendarFor(snapshot.today),
    settings: {
      monthly_cap_ars: s.monthly_cap_ars, autonomous: s.autonomous, auto_pause_min_spend_ars: s.auto_pause_min_spend_ars,
      auto_pause_days: s.auto_pause_days, business_notes: s.business_notes,
    },
    purchaseAction: purchaseActionSection(purchaseAction),
    account: { spendToday: snapshot.spendToday, month: snapshot.month },
    // Pausados sin gasto, palabras fuera del tope y grupos de recursos de campañas que no son PMax activas: solo se cuentan
    omittedPausedWithoutActivity: structure.omitted,
    campaigns: structure.campaigns,
    adGroups: structure.adGroups,
    keywords: structure.keywords,
    searchTerms: structure.searchTerms,
    assetGroups: structure.assetGroups,
    unusedCreatives: unusedCreatives.map((c) => ({
      id: c.id, name: c.name, link: c.link, notes: c.notes, headlines: list(c.headlines), long_headline: c.long_headline,
      descriptions: list(c.descriptions), images: images(c), youtube: Boolean(c.youtube_url),
    })),
    openCreativeRequests: openRequests.map((r) => ({ concept: r.concept, created_at: r.created_at })),
    activeLearnings: learnings.map((l) => ({ id: l.id, text: l.text, evidence: l.evidence })),
    pendingRecommendations: pending.map((d) => ({ id: d.id, tool: d.tool, title: d.title, input: decisionInput(d.input), created_at: d.created_at })),
    recentDecisions: recent.filter((d) => d.status !== 'pending').map((d) => ({
      id: d.id, tool: d.tool, title: d.title, input: decisionInput(d.input), status: d.status, outcome: d.outcome, created_at: d.created_at, decided_at: d.decided_at,
    })),
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

// Corrida del agente de Google: foto de la cuenta por familia, herramientas de Google + equipo
export function createGoogleAgentRunner({ anthropic, gads, repo, execute, model = DEFAULT_MODEL, log = console }) {
  return createAgentRunner({
    anthropic, repo, model, log,
    buildContext: () => buildGoogleContext({ gads, repo }),
    systemPrompt: GOOGLE_SYSTEM_PROMPT,
    tools: GOOGLE_TOOL_DEFINITIONS,
    dispatch: createGoogleDispatcher({ gads, repo, execute }),
    platformLabel: 'Google Ads',
  });
}
