import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpError } from '../repo/ads.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
export const bad = (msg) => httpError(400, msg);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidParam = (v) => {
  if (!UUID.test(v)) throw httpError(404, 'no encontrado');
  return v;
};
export const text = (v, { max, required, label }) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null) throw bad(`${label}: tiene que ser texto`);
  if (required && !s) throw bad(`Falta ${label}`);
  if (s.length > max) throw bad(`${label}: máximo ${max} caracteres`);
  return s;
};

export const isJpgOrPng = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG');

export function sizeLimit(max, msg) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      cb(n > max ? httpError(413, msg) : null, chunk);
    },
  });
}

export async function readBuffer(req, max, msg) {
  const chunks = [];
  await pipeline(req, sizeLimit(max, msg), async function* (src) {
    for await (const c of src) chunks.push(c);
  });
  return Buffer.concat(chunks);
}

const SNAPSHOT_ERROR_TTL_MS = 2 * 60_000;
const SNAPSHOT_WAIT_MS = 15_000; // el panel no espera más que esto: la consulta sigue y llena el cache

// La foto de la plataforma se cachea unos minutos: cada carga del panel no le pega a la API.
// Una sola consulta a la vez (si la plataforma limita, los reintentos tardan minutos y cada recarga sumaría llamadas)
// y un error se recuerda un rato para no insistirle a una cuenta que ya está limitada.
export function createSnapshotCache(build, { ttlMs }) {
  let cache = null;
  let inflight = null;
  let failure = null;
  async function get(force) {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache.data;
    if (!force && failure && Date.now() - failure.at < SNAPSHOT_ERROR_TTL_MS) throw failure.err;
    inflight ??= build()
      .then((data) => {
        cache = { at: Date.now(), data };
        failure = null;
        return data;
      }, (err) => {
        failure = { at: Date.now(), err };
        throw err;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }
  return {
    get,
    // Para el panel: la foto o, si tarda o falla, la última que hubo con el error
    async forPanel(force) {
      let timer;
      const slow = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('está tardando en responder (seguramente por el límite de llamadas); se sigue cargando, probá en un rato')), SNAPSHOT_WAIT_MS);
      });
      try {
        return { data: await Promise.race([get(force), slow]), error: null };
      } catch (err) {
        return { data: cache?.data ?? null, error: String(err.message || err) };
      } finally {
        clearTimeout(timer);
      }
    },
    invalidate: () => { cache = null; },
  };
}

// Errores esperables con su código; el resto, 500 sin detalles
export const agentErrorHandler = (label) => (err, _req, res, _next) => { // eslint-disable-line no-unused-vars
  if ([400, 404, 409, 413, 415, 502, 503].includes(err.status)) return res.status(err.status).json({ error: err.message });
  console.error(`[${label}]`, err);
  res.status(500).json({ error: 'error interno' });
};

const SETTINGS = {
  agent_enabled: (v) => typeof v === 'boolean',
  autonomous: (v) => typeof v === 'boolean',
  monthly_cap_ars: (v) => Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  business_notes: (v) => typeof v === 'string' && v.length <= 5000,
  auto_pause_min_spend_ars: (v) => Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  auto_pause_days: (v) => Number.isInteger(v) && v >= 1 && v <= 30,
};
// Solo Google: la acción de conversión que cuenta como compra
const PURCHASE_ACTION = (v) => v === null || (typeof v === 'string' && /^customers\/\d+\/conversionActions\/\d+$/.test(v));

// Rutas del agente comunes a las plataformas, bajo `base` ('/ads' | '/gads').
// `need` es el middleware que responde 503 si la plataforma no está conectada; startRun/execute pueden faltar.
export function mountAgentRoutes(router, {
  base, repo, startRun, execute, need, invalidate = () => {}, takeBaseline, allowPurchaseAction = false, log = console,
}) {
  const r = router;
  const settingsRules = allowPurchaseAction ? { ...SETTINGS, purchase_action: PURCHASE_ACTION } : SETTINGS;

  async function runManual() {
    const { run, done } = await startRun('manual');
    done.finally(invalidate);
    return run;
  }

  // Para el globito de la navegación: sin tocar la plataforma
  r.get(`${base}/badge`, wrap(async (_req, res) => {
    const [pendingCount, openQuestions] = await Promise.all([repo.countPending(), repo.countOpenQuestions()]);
    res.json({ pendingCount, openQuestions });
  }));

  r.get(`${base}/runs`, wrap(async (_req, res) => res.json({ runs: await repo.listRuns(20) })));

  r.post(`${base}/runs`, need, wrap(async (_req, res) => {
    if (!startRun) throw httpError(503, 'Falta la clave de Claude (ANTHROPIC_API_KEY) en el servidor.');
    res.status(202).json({ run: await runManual() });
  }));

  r.get(`${base}/decisions`, wrap(async (req, res) => {
    const { status } = req.query;
    if (status && !['pending', 'executed', 'rejected', 'failed'].includes(status)) throw bad('status inválido');
    res.json({ decisions: await repo.listDecisions({ status, limit: 100 }) });
  }));

  r.post(`${base}/decisions/:id/approve`, need, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const d = await repo.claimPending(id, 'executed');
    try {
      const result = await execute(d.tool, d.input);
      await repo.setDecisionResult(id, { status: 'executed', result });
    } catch (err) {
      await repo.setDecisionResult(id, { status: 'failed', error: String(err.message || err) });
    }
    invalidate();
    res.json({ decision: await repo.getDecision(id) });
  }));

  r.post(`${base}/decisions/:id/reject`, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    await repo.claimPending(id, 'rejected');
    res.json({ decision: await repo.getDecision(id) });
  }));

  r.get(`${base}/requests`, wrap(async (_req, res) => res.json({ requests: await repo.listRequests({ status: 'open' }) })));
  r.post(`${base}/requests/:id/done`, wrap(async (req, res) => res.json({ request: await repo.closeRequest(uuidParam(req.params.id)) })));

  r.get(`${base}/learnings`, wrap(async (_req, res) => res.json({ learnings: await repo.listLearnings() })));
  r.delete(`${base}/learnings/:id`, wrap(async (req, res) => {
    await repo.deleteLearning(uuidParam(req.params.id));
    res.json({ ok: true });
  }));

  r.get(`${base}/questions`, wrap(async (req, res) => {
    const status = req.query.status || 'open';
    if (!['open', 'answered'].includes(status)) throw bad('status inválido');
    res.json({ questions: await repo.listQuestions({ status, limit: 30 }) });
  }));

  r.post(`${base}/questions/:id/answer`, wrap(async (req, res) => {
    const id = uuidParam(req.params.id);
    const answer = text(req.body?.answer, { max: 2000, required: true, label: 'la respuesta' });
    const question = await repo.answerQuestion(id, answer);
    let run = null;
    let note = null;
    if (req.body?.analyze === true) {
      if (!startRun || !execute) {
        note = 'Respuesta guardada. El agente no está configurado para analizar ahora.';
      } else {
        try {
          run = await runManual();
        } catch (err) {
          if (err.status !== 409) throw err;
          note = 'Ya hay un análisis corriendo: el agente la toma en el próximo.';
        }
      }
    }
    res.json({ question, run, note });
  }));

  r.post(`${base}/questions/:id/dismiss`, wrap(async (req, res) => {
    res.json({ question: await repo.dismissQuestion(uuidParam(req.params.id)) });
  }));

  r.get(`${base}/settings`, wrap(async (_req, res) => res.json({ settings: await repo.getSettings() })));
  r.put(`${base}/settings`, wrap(async (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (!Object.hasOwn(settingsRules, k)) throw bad(`campo desconocido: ${k}`);
      if (!settingsRules[k](v)) throw bad(`${k} inválido`);
      patch[k] = v;
    }
    const { settings, changed } = await repo.updateSettings(patch);
    // Al prender el agente se guarda la foto del "antes", sin hacer esperar al panel
    if (takeBaseline && changed.includes('agent_enabled') && settings.agent_enabled === true) {
      Promise.resolve()
        .then(() => takeBaseline('activated'))
        .catch((err) => log.error(`[${base}] no pude guardar la línea de base:`, err));
    }
    res.json({ settings });
  }));
}
