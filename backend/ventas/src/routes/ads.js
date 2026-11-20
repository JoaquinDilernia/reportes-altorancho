import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { buildSnapshot } from '../ads/snapshot.js';
import { loadIgPosts } from '../ads/igPosts.js';
import { isStoreLink } from '../ads/agent.js';
import { httpError } from '../repo/ads.js';
import {
  mountAgentRoutes, wrap, bad, uuidParam, text, isJpgOrPng, sizeLimit, readBuffer, createSnapshotCache, agentErrorHandler,
} from './agentRoutes.js';

const META_ID = /^\d{1,30}$/;
const metaIdOf = (v) => {
  if (!META_ID.test(String(v ?? ''))) throw bad('Id de Meta inválido');
  return String(v);
};

const IMAGE_MAX = 8 * 1024 * 1024;
const VIDEO_MAX = 200 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
// MP4/MOV: la caja de tipo ('ftyp', o 'moov'/'wide'/'mdat' en MOV viejos) está en el byte 4
const isMp4OrMov = (b) => ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(b.subarray(4, 8).toString('latin1'));

const LEVEL_LABEL = { campaign: 'la campaña', adset: 'el conjunto', ad: 'el anuncio' };
const SNAPSHOT_TTL_MS = 5 * 60_000;

// meta/startRun/execute pueden faltar: el panel avisa qué falta configurar
export function createAdsRouter({ repo, meta, reports, startRun, execute, identity, config, takeBaseline }) {
  const r = express.Router();
  const needMeta = (_req, _res, next) => next(meta && execute ? undefined : httpError(503, 'Falta conectar Meta (META_ACCESS_TOKEN) en el servidor.'));

  const snapshots = createSnapshotCache(() => buildSnapshot({ meta, reports }), { ttlMs: SNAPSHOT_TTL_MS });
  let igCache = null;
  async function igPosts(force) {
    if (!force && igCache && Date.now() - igCache.at < SNAPSHOT_TTL_MS) return igCache.data;
    const { igUserId } = await identity();
    if (!igUserId) throw new Error('la cuenta publicitaria no tiene una cuenta de Instagram vinculada (cargá META_ADS_IG_USER_ID)');
    const data = await loadIgPosts({ meta, repo, igUserId });
    igCache = { at: Date.now(), data };
    return data;
  }
  const invalidate = () => {
    snapshots.invalidate();
    igCache = null;
  };

  r.get('/ads/overview', wrap(async (req, res) => {
    const [settings, runs, pendingCount, openQuestions] = await Promise.all([
      repo.getSettings(), repo.listRuns(1), repo.countPending(), repo.countOpenQuestions(),
    ]);
    const { data: snap, error: metaError } = meta ? await snapshots.forPanel(req.query.refresh === '1') : { data: null, error: null };
    res.json({
      configured: { meta: Boolean(meta), agent: Boolean(startRun) },
      settings, lastRun: runs[0] ?? null, pendingCount, openQuestions, snapshot: snap, metaError, storeUrl: config.storeUrl,
    });
  }));

  r.post('/ads/objects/:id/status', needMeta, wrap(async (req, res) => {
    const id = metaIdOf(req.params.id);
    const { level, status } = req.body ?? {};
    if (!LEVEL_LABEL[level]) throw bad('level inválido');
    if (!['ACTIVE', 'PAUSED'].includes(status)) throw bad('status inválido');
    const name = text(req.body.name, { max: 200, label: 'nombre' });
    const input = { level, object_id: id, object_name: name, status };
    const result = await execute('set_status', input);
    await repo.addDecision({
      tool: 'set_status', input, status: 'executed', result,
      title: `${status === 'ACTIVE' ? 'Activar' : 'Pausar'} ${LEVEL_LABEL[level]} ${name}`.trim(),
      reason: 'Hecho a mano desde el panel.',
    });
    invalidate();
    res.json({ ok: true });
  }));

  // Videos sin miniatura todavía (Meta los estaba procesando al subirlos): se pide una vez más y queda guardada
  async function withThumbnails(creatives) {
    if (!meta) return creatives;
    await Promise.all(creatives.flatMap((c) => ['feed', 'story'].map(async (slot) => {
      const m = c[slot];
      if (m?.kind !== 'video' || m.thumbnail_url) return;
      try {
        m.thumbnail_url = await meta.videoThumbnail(m.video_id);
        if (m.thumbnail_url) await repo.setThumbnail(c.id, slot, m.thumbnail_url);
      } catch {
        // sigue sin miniatura: el panel muestra el ícono de video
      }
    })));
    return creatives;
  }

  r.get('/ads/creatives', wrap(async (_req, res) => {
    res.json({ creatives: await withThumbnails(await repo.listCreatives()) });
  }));

  r.post('/ads/creatives', wrap(async (req, res) => {
    const b = req.body ?? {};
    const link = text(b.link, { max: 1000, label: 'el link' }) || config.storeUrl;
    if (!isStoreLink(link)) throw bad('El link tiene que empezar con https://');
    const creative = await repo.createCreative({
      name: text(b.name, { max: 60, required: true, label: 'el nombre' }),
      copy: text(b.copy, { max: 2000, required: true, label: 'el texto del anuncio' }),
      headline: text(b.headline, { max: 80, label: 'el título' }),
      notes: text(b.notes, { max: 2000, label: 'las notas' }),
      link,
    });
    res.status(201).json({ creative });
  }));

  r.patch('/ads/creatives/:id', wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const b = req.body ?? {};
    const patch = {};
    if (b.status !== undefined) {
      if (!['unused', 'archived'].includes(b.status)) throw bad('status inválido');
      patch.status = b.status;
    }
    for (const [k, max] of [['name', 60], ['copy', 2000], ['headline', 80], ['notes', 2000]]) {
      if (b[k] !== undefined) patch[k] = text(b[k], { max, required: k === 'name' || k === 'copy', label: k });
    }
    if (b.link !== undefined) {
      if (!isStoreLink(b.link)) throw bad('El link tiene que empezar con https://');
      patch.link = b.link;
    }
    const current = await repo.getCreative(id);
    if (['used', 'publishing'].includes(current.status)) throw httpError(409, 'Esta pieza ya está publicada en Meta.');
    res.json({ creative: await repo.updateCreative(id, patch) });
  }));

  // Archivo de la pieza: el cuerpo es el archivo crudo. Va directo a la biblioteca de Meta
  // (imagen → hash; video → id), así no hace falta storage propio.
  r.put('/ads/creatives/:id/media/:slot', needMeta, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const { slot } = req.params;
    if (!['feed', 'story'].includes(slot)) throw httpError(404, 'no encontrado');
    const creative = await repo.getCreative(id);
    if (creative.status !== 'unused') throw httpError(409, 'Esta pieza ya no se puede editar.');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const originalName = decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 200);
    const declared = Number(req.get('content-length'));

    if (IMAGE_TYPES.includes(mime)) {
      if (declared > IMAGE_MAX) throw httpError(413, 'La imagen pesa más de 8 MB.');
      const buffer = await readBuffer(req, IMAGE_MAX, 'La imagen pesa más de 8 MB.');
      if (!isJpgOrPng(buffer)) throw httpError(415, 'Solo se aceptan imágenes JPG o PNG.');
      const img = await meta.uploadImage(buffer);
      const media = await repo.setMedia(id, slot, { kind: 'image', imageHash: img.hash, imageUrl: img.url, originalName });
      return res.status(201).json({ media });
    }
    if (!VIDEO_TYPES.includes(mime)) throw httpError(415, 'Elegí una imagen JPG/PNG o un video MP4/MOV.');
    if (declared > VIDEO_MAX) throw httpError(413, 'El video pesa más de 200 MB.');
    const tmp = path.join(os.tmpdir(), `ad-${crypto.randomUUID()}.mp4`);
    try {
      await pipeline(req, sizeLimit(VIDEO_MAX, 'El video pesa más de 200 MB.'), fs.createWriteStream(tmp));
      const head = Buffer.alloc(12);
      const fh = await fs.promises.open(tmp);
      await fh.read(head, 0, 12, 0).finally(() => fh.close());
      if (!isMp4OrMov(head)) throw httpError(415, 'El archivo no es un video MP4 o MOV.');
      const videoId = await meta.uploadVideoFile(tmp, originalName || creative.name);
      const media = await repo.setMedia(id, slot, { kind: 'video', videoId, originalName });
      res.status(201).json({ media });
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }));

  r.post('/ads/creatives/:id/publish', needMeta, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const adsetId = metaIdOf(req.body?.adset_id);
    const adsetName = text(req.body?.adset_name, { max: 200, label: 'conjunto' });
    const creative = await repo.getCreative(id);
    const input = { creative_id: id, adset_id: adsetId, adset_name: adsetName };
    const base = { tool: 'create_ad', input, title: `Publicar "${creative.name}" en ${adsetName || adsetId}`, reason: 'Hecho a mano desde el panel.' };
    try {
      const result = await execute('create_ad', input);
      await repo.addDecision({ ...base, status: 'executed', result });
      invalidate();
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status === 409) throw err;
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      throw httpError(502, `Meta rechazó el anuncio: ${err.message}`);
    }
  }));

  r.get('/ads/ig-posts', needMeta, wrap(async (req, res) => {
    try {
      res.json({ posts: await igPosts(req.query.refresh === '1') });
    } catch (err) {
      throw httpError(502, `Instagram no respondió: ${err.message}`);
    }
  }));

  r.post('/ads/ig-posts/:mediaId/promote', needMeta, wrap(async (req, res) => {
    const mediaId = metaIdOf(req.params.mediaId);
    const b = req.body ?? {};
    const adsetId = metaIdOf(b.adset_id);
    const adsetName = text(b.adset_name, { max: 200, label: 'conjunto' });
    const link = text(b.link, { max: 1000, label: 'el link' });
    if (link && !isStoreLink(link)) throw bad('El link tiene que empezar con https://');
    const input = { ig_media_id: mediaId, adset_id: adsetId, adset_name: adsetName, permalink: text(b.permalink, { max: 500, label: 'permalink' }), link: link || config.storeUrl };
    const base = { tool: 'promote_ig_post', input, title: `Promocionar post de Instagram en ${adsetName || adsetId}`, reason: 'Hecho a mano desde el panel.' };
    try {
      const result = await execute('promote_ig_post', input);
      await repo.addDecision({ ...base, status: 'executed', result });
      invalidate();
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status === 409) throw err;
      await repo.addDecision({ ...base, status: 'failed', error: String(err.message || err) });
      throw httpError(502, `Meta rechazó el anuncio: ${err.message}`);
    }
  }));

  // Runs, decisiones, pedidos, aprendizajes, preguntas, globito y ajustes: comunes a las plataformas
  mountAgentRoutes(r, {
    base: '/ads', repo, startRun, execute, need: needMeta, invalidate, takeBaseline,
  });

  r.use(agentErrorHandler('api pauta'));

  return r;
}
