import express from 'express';
import { buildGoogleSnapshot } from '../gads/snapshot.js';
import { listConversionActions, resolvePurchaseAction } from '../gads/purchaseAction.js';
import { KEYWORD_ID, NUMERIC_ID } from '../gads/executor.js';
import { isStoreLink } from '../ads/agent.js';
import { httpError } from '../repo/ads.js';
import {
  mountAgentRoutes, wrap, bad, uuidParam, text, isJpgOrPng, readBuffer, createSnapshotCache, agentErrorHandler,
} from './agentRoutes.js';

const LEVEL_LABEL = { campaign: 'la campaña', ad_group: 'el grupo de anuncios', keyword: 'la palabra clave' };
const TARGETS = ['asset_group', 'ad_group'];
const SLOTS = ['landscape', 'square', 'portrait'];
const IMAGE_MAX = 5 * 1024 * 1024; // límite de Google para imágenes
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
// La foto de Google es más cara que la de Meta (cuota diaria): se cachea más
const SNAPSHOT_TTL_MS = 30 * 60_000;

const objectIdOf = (level, v) => {
  const id = String(v ?? '');
  if (level === 'keyword' ? !KEYWORD_ID.test(id) : !NUMERIC_ID.test(id)) throw bad(level === 'keyword' ? 'Id de palabra clave inválido' : 'Id de Google inválido');
  return id;
};

// Lo que rechaza Google (o su cuota) llega al panel como 502 con el mensaje de Google
const fromGoogle = (err) => Object.hasOwn(err, 'googleCode');
async function google(fn) {
  try {
    return await fn();
  } catch (err) {
    if (fromGoogle(err)) throw httpError(502, err.message);
    throw err;
  }
}

// Lista de textos de la pieza: recorta, saca vacíos y valida cantidad y largo
function textList(v, { min, max, maxLen, label }) {
  if (!Array.isArray(v)) throw bad(`${label}: tiene que ser una lista`);
  const out = v.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  if (out.length < min || out.length > max) throw bad(`Cargá entre ${min} y ${max} ${label}.`);
  const long = out.find((t) => t.length > maxLen);
  if (long) throw bad(`"${long}" pasa los ${maxLen} caracteres permitidos para ${label}.`);
  return out;
}

// Link de YouTube → id del video ('' o null → sin video)
const YOUTUBE = [
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]+)/,
  /^(?:https?:\/\/)?youtu\.be\/([\w-]+)/,
  /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/([\w-]+)/,
];
function youtubeId(v) {
  const s = text(v, { max: 500, label: 'el link de YouTube' });
  if (!s) return null;
  for (const re of YOUTUBE) {
    const m = s.match(re);
    if (m) return m[1];
  }
  throw bad('El link de YouTube no es válido (youtube.com/watch?v=…, youtu.be/… o youtube.com/shorts/…).');
}

const FIELDS = {
  name: (v) => text(v, { max: 60, required: true, label: 'el nombre' }),
  headlines: (v) => JSON.stringify(textList(v, { min: 3, max: 5, maxLen: 30, label: 'títulos' })),
  long_headline: (v) => text(v, { max: 90, label: 'el título largo' }),
  descriptions: (v) => JSON.stringify(textList(v, { min: 2, max: 5, maxLen: 90, label: 'descripciones' })),
  youtube_url: youtubeId,
  notes: (v) => text(v, { max: 2000, label: 'las notas' }),
  link: (v) => {
    const link = text(v, { max: 1000, label: 'el link' });
    if (!isStoreLink(link)) throw bad('El link tiene que empezar con https://');
    return link;
  },
};

// gads/startRun/execute pueden faltar: el panel avisa qué falta configurar
export function createGadsRouter({ repo, gads, startRun, execute, config, takeBaseline }) {
  const r = express.Router();
  const needGoogle = (_req, _res, next) => next(gads && execute
    ? undefined
    : httpError(503, 'Falta conectar Google Ads (GOOGLE_ADS_SERVICE_ACCOUNT y GOOGLE_ADS_CUSTOMER_ID) en el servidor.'));

  const snapshots = createSnapshotCache(async () => {
    const purchaseAction = await resolvePurchaseAction(gads, await repo.getSettings());
    return { purchaseAction, snapshot: await buildGoogleSnapshot({ gads, purchaseAction }) };
  }, { ttlMs: SNAPSHOT_TTL_MS });
  const invalidate = snapshots.invalidate;

  r.get('/gads/overview', wrap(async (req, res) => {
    const [settings, runs, pendingCount, openQuestions] = await Promise.all([
      repo.getSettings(), repo.listRuns(1), repo.countPending(), repo.countOpenQuestions(),
    ]);
    const { data, error } = gads ? await snapshots.forPanel(req.query.refresh === '1') : { data: null, error: null };
    res.json({
      configured: { google: Boolean(gads), agent: Boolean(startRun) },
      settings, lastRun: runs[0] ?? null, pendingCount, openQuestions,
      snapshot: data?.snapshot ?? null, purchaseAction: data?.purchaseAction ?? null, googleError: error, storeUrl: config.storeUrl,
    });
  }));

  r.get('/gads/conversion-actions', needGoogle, wrap(async (_req, res) => {
    res.json({ actions: await google(() => listConversionActions(gads)) });
  }));

  r.post('/gads/objects/:id/status', needGoogle, wrap(async (req, res) => {
    const { level, status } = req.body ?? {};
    if (!LEVEL_LABEL[level]) throw bad('level inválido');
    if (!['ENABLED', 'PAUSED'].includes(status)) throw bad('status inválido');
    const id = objectIdOf(level, req.params.id);
    const name = text(req.body.name, { max: 200, label: 'nombre' });
    const input = { level, object_id: id, object_name: name, status };
    const result = await google(() => execute('set_status', input));
    await repo.addDecision({
      tool: 'set_status', input, status: 'executed', result,
      title: `${status === 'ENABLED' ? 'Activar' : 'Pausar'} ${LEVEL_LABEL[level]} ${name}`.trim(),
      reason: 'Hecho a mano desde el panel.',
    });
    invalidate();
    res.json({ ok: true });
  }));

  r.get('/gads/creatives', wrap(async (_req, res) => {
    res.json({ creatives: await repo.listCreatives() });
  }));

  r.post('/gads/creatives', wrap(async (req, res) => {
    const b = req.body ?? {};
    const creative = await repo.createCreative({
      name: FIELDS.name(b.name),
      copy: '',
      link: b.link ? FIELDS.link(b.link) : config.storeUrl,
      headlines: FIELDS.headlines(b.headlines),
      long_headline: FIELDS.long_headline(b.long_headline),
      descriptions: FIELDS.descriptions(b.descriptions),
      youtube_url: FIELDS.youtube_url(b.youtube_url),
      notes: FIELDS.notes(b.notes),
    });
    res.status(201).json({ creative });
  }));

  r.patch('/gads/creatives/:id', wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const b = req.body ?? {};
    const patch = {};
    if (b.status !== undefined) {
      if (!['unused', 'archived'].includes(b.status)) throw bad('status inválido');
      patch.status = b.status;
    }
    for (const [k, parse] of Object.entries(FIELDS)) {
      if (b[k] !== undefined) patch[k] = parse(b[k]);
    }
    const current = await repo.getCreative(id);
    if (['used', 'publishing'].includes(current.status)) throw httpError(409, 'Esta pieza ya está publicada en Google.');
    res.json({ creative: await repo.updateCreative(id, patch) });
  }));

  // Imagen de la pieza: el cuerpo es el archivo crudo y va directo a la biblioteca de recursos de Google
  r.put('/gads/creatives/:id/media/:slot', needGoogle, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const { slot } = req.params;
    if (!SLOTS.includes(slot)) throw httpError(404, 'no encontrado');
    const creative = await repo.getCreative(id);
    if (creative.status !== 'unused') throw httpError(409, 'Esta pieza ya no se puede editar.');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mime)) throw httpError(415, 'Elegí una imagen JPG o PNG.');
    if (Number(req.get('content-length')) > IMAGE_MAX) throw httpError(413, 'La imagen pesa más de 5 MB.');
    const buffer = await readBuffer(req, IMAGE_MAX, 'La imagen pesa más de 5 MB.');
    if (!isJpgOrPng(buffer)) throw httpError(415, 'Solo se aceptan imágenes JPG o PNG.');
    const originalName = decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 200);
    // Google no deja repetir nombres de recursos: va con el slot y un pedazo del id de la pieza
    const assetName = await google(() => gads.uploadImageAsset(buffer, `${creative.name} - ${slot} - ${id.slice(0, 8)}-${Date.now().toString(36)}`));
    const media = await repo.setMedia(id, slot, { kind: 'image', assetName, originalName });
    res.status(201).json({ media });
  }));

  // Publicar a mano: la pieza va a un grupo de recursos (PMax) o a un grupo de anuncios (Demand Gen)
  r.post('/gads/creatives/:id/publish', needGoogle, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const b = req.body ?? {};
    if (!TARGETS.includes(b.target)) throw bad('Destino inválido: elegí un grupo de recursos o un grupo de anuncios.');
    const targetId = objectIdOf(b.target, b.target_id);
    const targetName = text(b.target_name, { max: 200, label: 'destino' });
    const creative = await repo.getCreative(id);
    const input = { creative_id: id, target: b.target, target_id: targetId, target_name: targetName };
    const base = { tool: 'add_assets', input, title: `Publicar "${creative.name}" en ${targetName || targetId}`, reason: 'Hecho a mano desde el panel.' };
    try {
      const result = await execute('add_assets', input);
      await repo.addDecision({ ...base, status: 'executed', result });
      invalidate();
      res.json({ ok: true, ...result });
    } catch (err) {
      if (!fromGoogle(err)) throw err;
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      throw httpError(502, `Google rechazó la pieza: ${err.message}`);
    }
  }));

  // Cambiar la acción de compra cambia las compras de la foto
  r.put('/gads/settings', (req, res, next) => {
    if (Object.hasOwn(req.body ?? {}, 'purchase_action')) res.on('finish', invalidate);
    next();
  });

  // Runs, decisiones, pedidos, aprendizajes, preguntas, globito y ajustes: comunes a las plataformas
  mountAgentRoutes(r, {
    base: '/gads', repo, startRun, execute, need: needGoogle, invalidate, takeBaseline, allowPurchaseAction: true,
  });

  r.use(agentErrorHandler('api pauta google'));

  return r;
}
