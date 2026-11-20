// Rutas de cambios y devoluciones web: panel (/admin/web-returns, guard de
// admin) y bot de WhatsApp/Instagram (/bot/web-returns, clave compartida).
// La lógica vive en webReturnActions (funciones planas, testeables con deps
// falsas); las rutas solo la conectan.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { handle, httpError, validId } from './posHttp.mjs';
import { STATUSES, canEdit, validateDraft, isLate } from './posWebReturns.mjs';
import { buildDraftFromInput } from './posWebReturnsDraft.mjs';
import { resolveWebPurchase } from './posWebReturnsPurchase.mjs';
import * as store from './posWebReturnsStore.mjs';
import * as service from './posWebReturnsService.mjs';
import { saveEvidence, evidenceUrl } from './posWebReturnsEvidence.mjs';
import { getSettings, getLocales, webReturnDestinationsOf } from './posConfig.mjs';

const BOT_USER = 'bot';
const BOT_CHANNELS = ['whatsapp', 'instagram'];
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---- Cuerpos grandes ----
// Evidencia y etiquetas llegan en base64 (hasta 15 MB de archivo). El parser
// global de la app se las saltea y las parsea este router con 25 MB, recién
// después del guard: sin auth no se lee el cuerpo.
export const BIG_BODY_PATH = /^\/api\/pos\/(admin|bot)\/web-returns\/[^/]+\/(evidence|label)$/;

export function jsonExceptBigBodies(parser = express.json()) {
  return (req, res, next) => (BIG_BODY_PATH.test(req.path) ? next() : parser(req, res, next));
}

// ---- Bot: clave compartida ----
const digest = (s) => createHash('sha256').update(String(s)).digest();

export function requireBotKey(req, res, next) {
  const secret = process.env.POS_BOT_SECRET;
  if (!secret) return res.status(503).json({ error: 'Integración con el bot no configurada' });
  const given = req.get?.('x-pos-bot-key') ?? req.headers?.['x-pos-bot-key'] ?? '';
  // Se comparan los hashes: mismo largo siempre, sin filtrar el largo de la clave.
  if (!given || !timingSafeEqual(digest(given), digest(secret))) return res.status(401).json({ error: 'Clave del bot inválida' });
  return next();
}

// ---- Identidad del cliente (bot) ----
const last8 = (v) => String(v ?? '').replace(/\D/g, '').slice(-8);

export function phoneMatches(a, b) {
  const x = last8(a);
  return x.length === 8 && x === last8(b);
}

export function identityMatches({ phone, email } = {}, customer = {}) {
  if (phoneMatches(phone, customer?.phone)) return true;
  const e = String(email ?? '').trim().toLowerCase();
  return !!e && e === String(customer?.email ?? '').trim().toLowerCase();
}

const assertIdentity = (who, customer) => {
  if (!identityMatches(who, customer)) throw httpError('No pudimos validar que el pedido sea tuyo', 403);
};

// ---- Acciones ----
const TRANSITIONS = { approve: 'approve', reject: 'reject', derive: 'derive', receive: 'receive', 'refund-done': 'refundDone', close: 'close' };
// Lo que el cliente nunca pisa en un PATCH (lo pone el servidor).
const SERVER_KEYS = ['purchase', 'evidence', 'channel', 'botConversationId', 'number', 'status', 'money', 'odoo', 'history', 'busy', 'id'];

const slim = (r) => ({
  id: r.id, number: r.number, status: r.status, kind: r.kind, reason: r.reason,
  customer: { name: r.customer?.name ?? '' }, purchase: { ref: r.purchase?.ref ?? '' },
  createdAt: r.createdAt, late: !!r.purchase?.late, busy: !!r.busy,
});

function parseStatus(status) {
  const list = String(status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.some((s) => !STATUSES.includes(s))) throw new Error('Estado inválido');
  if (list.length > 1) return list;
  return list[0];
}

const requireTn = (v) => {
  const n = String(v ?? '').trim();
  if (!n) throw new Error('Falta el número de pedido');
  return n;
};

export function defaultDeps() {
  return {
    store, service, evidence: { saveEvidence, evidenceUrl },
    getSettings, getLocales, resolve: (n, opts) => resolveWebPurchase(n, undefined, opts), now: () => new Date(),
  };
}

export function webReturnActions(deps = defaultDeps()) {
  const { store: st, service: sv, evidence: ev } = deps;
  const sign = async (path) => {
    if (!path) return null;
    try { return await ev.evidenceUrl(path); } catch { return null; }
  };

  async function editable(id) {
    const cur = await st.getWebReturn(id);
    if (!canEdit(cur)) throw new Error('Esta solicitud ya no se puede editar');
    return cur;
  }

  return {
    async list({ status, q } = {}) {
      const rows = await st.listWebReturns({ status: parseStatus(status), q: String(q ?? '').trim() });
      return rows.map(slim);
    },

    async count() {
      return { pending: await st.countPending() };
    },

    async detail(id) {
      const r = await st.getWebReturn(id);
      const [settings, locales, evidence, labelUrl] = await Promise.all([
        deps.getSettings(), deps.getLocales(),
        Promise.all((r.evidence ?? []).map(async (e) => ({ ...e, url: await sign(e.storagePath) }))),
        sign(r.logistics?.labelPath),
      ]);
      return {
        ...r, evidence, logistics: { ...(r.logistics ?? {}), labelUrl },
        destinations: webReturnDestinationsOf(settings),
        locales: (locales ?? []).map((l) => ({ id: l.id, name: l.name })),
      };
    },

    // excludeRequestId: al editar, la propia solicitud no descuenta lo disponible.
    purchase(tnNumber, excludeRequestId = null) {
      return deps.resolve(requireTn(tnNumber), { excludeRequestId: excludeRequestId || null });
    },

    async createManual(body, user) {
      const draft = await buildDraftFromInput(body, { channel: 'manual', settings: await deps.getSettings(), now: deps.now(), resolve: deps.resolve });
      return st.createWebReturn(draft, user, deps.now());
    },

    async patch(id, body, user) {
      const cur = await editable(id);
      const settings = await deps.getSettings();
      const b = Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => !SERVER_KEYS.includes(k)));
      const keep = { labelPath: cur.logistics?.labelPath ?? null, derivedLocalId: cur.logistics?.derivedLocalId ?? null };
      const logistics = { ...(cur.logistics ?? {}), ...(b.logistics ?? {}), ...keep };
      let draft;
      if ('tnNumber' in b || 'returnLines' in b) {
        const sameOrder = !('tnNumber' in b) || String(b.tnNumber).replace(/^[#\s]+/, '').trim() === String(cur.purchase?.ref ?? '');
        // Otro pedido: el cliente se precarga del pedido nuevo, no del anterior.
        const customer = sameOrder ? { ...(cur.customer ?? {}), ...(b.customer ?? {}) } : (b.customer ?? {});
        draft = await buildDraftFromInput(
          { ...cur, tnNumber: cur.purchase?.ref, ...b, customer, logistics },
          { channel: cur.channel, settings, now: cur.createdAt ?? deps.now(), resolve: deps.resolve, evidence: cur.evidence ?? [], logisticsExtra: keep, excludeRequestId: id },
        );
      } else {
        draft = validateDraft({
          ...cur, ...b, customer: { ...(cur.customer ?? {}), ...(b.customer ?? {}) }, logistics,
          purchase: cur.purchase, evidence: cur.evidence, channel: cur.channel, botConversationId: cur.botConversationId,
        }, { settings, requireEvidence: false });
      }
      return st.updateDraft(id, draft, user);
    },

    async addEvidence(id, body, user) {
      const cur = await editable(id);
      if ((cur.evidence ?? []).length >= store.MAX_EVIDENCE) throw new Error(`Se pueden cargar hasta ${store.MAX_EVIDENCE} archivos`);
      const saved = await ev.saveEvidence({ requestId: id, base64: body?.base64, mimetype: body?.mimetype, uploadedBy: user });
      return st.appendEvidence(id, saved, user);
    },

    async setLabel(id, body, user) {
      const cur = await st.getWebReturn(id);
      if (cur.status !== 'aprobada') throw new Error('La etiqueta se carga con la solicitud aprobada');
      const saved = await ev.saveEvidence({ requestId: id, base64: body?.base64, mimetype: body?.mimetype, uploadedBy: user, kind: 'label' });
      return st.setLabel(id, saved.storagePath, user);
    },

    async transition(action, id, body, user) {
      const fn = TRANSITIONS[action];
      if (!fn) throw new Error(`Acción desconocida: ${action}`);
      if (fn === 'approve') {
        // Antes de tocar Odoo: la solicitud completa, con evidencia si es falla.
        const [cur, settings] = await Promise.all([st.getWebReturn(id), deps.getSettings()]);
        validateDraft(cur, { settings, requireEvidence: true });
        return sv.approve(id, user);
      }
      if (fn === 'reject') return sv.reject(id, user, body?.reason);
      if (fn === 'derive') {
        const localId = String(body?.localId ?? '').trim();
        if (!(await deps.getLocales()).some((l) => l.id === localId)) throw new Error('Elegí un local válido');
        return sv.derive(id, user, localId);
      }
      if (fn === 'refundDone') return sv.refundDone(id, user, body?.note ?? null);
      return sv[fn](id, user);
    },

    // ---- Bot ----
    async botPurchase({ ref, phone, email } = {}) {
      const { tn, purchase, returnable } = await deps.resolve(requireTn(ref));
      assertIdentity({ phone, email }, tn?.customer);
      const settings = await deps.getSettings();
      return {
        ref: purchase.ref, date: purchase.date,
        late: purchase.date ? isLate(purchase.date, deps.now().toISOString(), settings) : false,
        customerName: tn?.customer?.name ?? '',
        returnable: (returnable ?? []).map((l) => ({ purchaseLineId: l.purchaseLineId, sku: l.sku, name: l.name, available: l.available, unitValue: l.unitValue })),
      };
    },

    async botCreate(body) {
      const b = body ?? {};
      const channel = String(b.channel ?? '');
      if (!BOT_CHANNELS.includes(channel)) throw new Error('Canal inválido');
      const conversation = String(b.botConversationId ?? '').trim();
      if (!conversation) throw new Error('Falta la conversación del bot');
      const resolved = await deps.resolve(requireTn(b.tnNumber));
      assertIdentity({ phone: b.phone, email: b.email }, resolved.tn?.customer);
      const draft = await buildDraftFromInput({ ...b, botConversationId: conversation }, {
        channel, settings: await deps.getSettings(), now: deps.now(), resolve: async () => resolved,
      });
      const r = await st.createWebReturn(draft, BOT_USER, deps.now());
      return { id: r.id, number: r.number, status: r.status };
    },

    async botStatus(id) {
      const r = await st.getWebReturn(id);
      return { number: r.number, status: r.status, rejectReason: r.rejectReason ?? null };
    },
  };
}

// ---- Router ----
export function createWebReturnsRouter({ admins, deps } = {}) {
  if (!Array.isArray(admins) || !admins.length) throw new Error('createWebReturnsRouter: falta el guard de admin');
  const router = Router();
  const a = webReturnActions(deps ?? defaultDeps());
  const id = validId(REQUEST_ID, 'Id de solicitud');
  // Solo en evidencia y etiqueta, siempre después del guard (ver jsonExceptBigBodies).
  const bigJson = express.json({ limit: '25mb' });
  const user = (req) => req.posUser.name;

  router.get('/admin/web-returns', ...admins, handle((req) => a.list(req.query)));
  router.get('/admin/web-returns/count', ...admins, handle(() => a.count()));
  // ?exclude=<id>: la solicitud que se edita (mismo formato que el id de la ruta).
  const excludeId = (req, res, next) => (req.query.exclude == null ? next() : id({ params: { id: String(req.query.exclude) } }, res, next));
  router.get('/admin/web-returns/purchase/:tnNumber', ...admins, excludeId, handle((req) => a.purchase(req.params.tnNumber, req.query.exclude ?? null)));
  router.get('/admin/web-returns/:id', ...admins, id, handle((req) => a.detail(req.params.id)));
  router.post('/admin/web-returns', ...admins, handle((req) => a.createManual(req.body ?? {}, user(req))));
  router.patch('/admin/web-returns/:id', ...admins, id, handle((req) => a.patch(req.params.id, req.body ?? {}, user(req))));
  router.post('/admin/web-returns/:id/evidence', ...admins, id, bigJson, handle(async (req) => {
    await a.addEvidence(req.params.id, req.body ?? {}, user(req));
    return a.detail(req.params.id);
  }));
  router.post('/admin/web-returns/:id/label', ...admins, id, bigJson, handle(async (req) => {
    await a.setLabel(req.params.id, req.body ?? {}, user(req));
    return a.detail(req.params.id);
  }));
  router.post('/admin/web-returns/:id/:action(approve|reject|derive|receive|refund-done|close)', ...admins, id,
    handle((req) => a.transition(req.params.action, req.params.id, req.body ?? {}, user(req))));

  router.get('/bot/web-returns/purchase', requireBotKey, handle((req) => a.botPurchase(req.query)));
  router.post('/bot/web-returns', requireBotKey, handle((req) => a.botCreate(req.body ?? {})));
  router.post('/bot/web-returns/:id/evidence', requireBotKey, id, bigJson, handle(async (req) => {
    const r = await a.addEvidence(req.params.id, req.body ?? {}, BOT_USER);
    return { number: r.number, status: r.status, evidence: (r.evidence ?? []).length };
  }));
  router.get('/bot/web-returns/:id', requireBotKey, id, handle((req) => a.botStatus(req.params.id)));

  return router;
}
