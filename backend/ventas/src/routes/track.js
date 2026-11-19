import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parseBatch } from '../engine/tracking.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'track', 'tracker.js');

// Público: el script de la tienda (/t.js) y adonde manda los eventos (/t/c).
// sendBeacon manda text/plain: no hay preflight de CORS ni hace falta leer la respuesta.
export function createTrackRouter({ repo, ownHost = 'altorancho.com', log = console, perMinute = 240 }) {
  const router = express.Router();
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const hits = new Map();
  let windowStart = Date.now();
  const limited = (ip) => {
    if (Date.now() - windowStart > 60e3) { hits.clear(); windowStart = Date.now(); }
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    return n > perMinute;
  };

  router.get('/t.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    res.send(script);
  });

  router.options('/t/c', (_req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }).sendStatus(204);
  });

  router.post('/t/c', express.text({ type: '*/*', limit: '16kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (limited(req.ip)) return res.sendStatus(429);
    const batch = parseBatch(req.body);
    if (!batch) return res.sendStatus(400);
    try {
      await repo.record(batch, { ownHost });
      res.sendStatus(204);
    } catch (err) {
      log.error('[track] no pude guardar:', err.message);
      res.sendStatus(500);
    }
  });
  return router;
}

// Para el panel (detrás de la auth de Reportes)
export function createTrackApiRouter({ repo }) {
  const router = express.Router();
  router.get('/tracking/order/:id', async (req, res, next) => {
    try {
      if (!/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
      res.json(await repo.journeyForOrder(req.params.id));
    } catch (err) { next(err); }
  });
  router.get('/tracking/stats', async (req, res, next) => {
    try {
      res.json(await repo.stats(Math.min(24 * 30, Number(req.query.hours) || 24)));
    } catch (err) { next(err); }
  });
  return router;
}
