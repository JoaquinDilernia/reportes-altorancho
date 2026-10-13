// Rutas /api/pos: punto de venta de locales. Todo cuelga de un token propio
// (posAuth) distinto al de la feria. Los errores salen como { error }.
import { Router } from 'express';
import {
  requirePosAuth, requirePosRole, generateToken, loginWithPin, loginWithPassword, scopeLocalId,
  assertOrderAccess, assertLineEditAccess, isAdminRole,
} from './posAuth.mjs';
import { listUsers, createUser, updateUser, deleteUser } from './posUsers.mjs';
import {
  getLocales, getSettings, getPaymentMethods, getPaymentMethodsById, saveLocale, saveSettings, savePaymentMethod, localeIdsOf,
} from './posConfig.mjs';
import { listPromotions, listActivePromotions, savePromotion } from './posPromotions.mjs';
import { searchCatalog, fetchFreeStock, groupStock, stockLocationIds } from './posCatalog.mjs';
import { readReservationsFor, appReservedFor } from './posStock.mjs';
import * as orders from './posOrders.mjs';
import { claimAndConfirmPos, annulPosOrder, invoicePosOrder, invoicingEnabledFor } from './posConfirm.mjs';
import { findPartnerForLookup, listOdooOptions } from './posOdoo.mjs';
import * as cash from './posCash.mjs';
import { computePosStats, monthsBetween } from './posStats.mjs';
import { fetchProductImage } from './odoo.mjs';
import { getDb } from './firestore.mjs';

const router = Router();
const auth = [requirePosAuth];
const sellers = [requirePosAuth, requirePosRole('vendedor', 'caja', 'admin')];
const cajas = [requirePosAuth, requirePosRole('caja', 'admin')];
const admins = [requirePosAuth, requirePosRole('admin')];

const httpError = (message, status) => Object.assign(new Error(message), { status });

export function statusOf(err) {
  if (err.status) return err.status;
  if (err.stage === 'claim') return 409;
  if (err.stage === 'odoo' || err.stage === 'post') return 502;
  if (/ no encontrad[oa]$/.test(err.message ?? '')) return 404;
  if (String(err.message ?? '').startsWith('Odoo RPC error')) return 502;
  if (['TypeError', 'AbortError', 'TimeoutError'].includes(err.name)) return 502;
  return 400;
}

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    const status = statusOf(err);
    if (status >= 500) console.error('[pos]', req.method, req.path, err.message);
    res.status(status).json({ error: err.message });
  }
};

// Límite de intentos fallidos de login por IP (en memoria).
export function createLoginLimiter({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now, sweepAt = 500 } = {}) {
  const entries = new Map();
  const sweep = () => {
    if (entries.size < sweepAt) return;
    for (const [ip, entry] of entries) if (now() - entry.since >= windowMs) entries.delete(ip);
  };
  const live = (ip) => {
    const entry = entries.get(ip);
    if (entry && now() - entry.since >= windowMs) {
      entries.delete(ip);
      return null;
    }
    return entry ?? null;
  };
  return {
    check: (ip) => (live(ip)?.count ?? 0) < max,
    fail(ip) {
      sweep();
      const entry = live(ip);
      if (entry) entry.count += 1;
      else entries.set(ip, { count: 1, since: now() });
    },
    reset: (ip) => { entries.delete(ip); },
    size: () => entries.size,
  };
}

const loginLimiter = createLoginLimiter();

// Cuenta el intento ANTES de esperar la base (si no, ráfagas en paralelo
// pasarían todas el chequeo); el éxito lo borra.
export async function throttledAttempt(limiter, ip, attempt) {
  if (!limiter.check(ip)) throw httpError('Demasiados intentos: esperá unos minutos', 429);
  limiter.fail(ip);
  const user = await attempt();
  if (!user) return null;
  limiter.reset(ip);
  return { token: generateToken(user), user };
}

const throttledLogin = (req, attempt) => throttledAttempt(loginLimiter, req.ip ?? 'unknown', attempt);

// Admin opera sobre el local del pedido (o el que pide); el resto, el suyo.
function actingUser(req, localId) {
  const user = req.posUser;
  return isAdminRole(user.role) ? { ...user, localId } : user;
}

async function orderFor(req) {
  const order = await orders.getOrder(req.params.id);
  assertOrderAccess(order, req.posUser);
  return order;
}

// ---- Login ----
router.post('/auth/pin', handle(async (req) => {
  const result = await throttledLogin(req, () => loginWithPin(req.body?.pin));
  if (!result) throw httpError('PIN incorrecto', 401);
  return result;
}));

router.post('/auth/login', handle(async (req) => {
  const result = await throttledLogin(req, () => loginWithPassword(req.body?.username, req.body?.password));
  if (!result) throw httpError('Usuario o contraseña incorrectos', 401);
  return result;
}));

// ---- Configuración visible para todos ----
router.get('/config', ...auth, handle(async () => {
  const [locales, paymentMethods, promotions, settings] = await Promise.all([
    getLocales(), getPaymentMethods(), listActivePromotions(), getSettings(),
  ]);
  return {
    locales: locales.filter((l) => l.active !== false).map(({ id, name, address, invoiceJournalId }) => ({ id, name, address, invoices: Boolean(invoiceJournalId) })),
    paymentMethods: paymentMethods.filter((m) => m.active !== false),
    promotions: promotions.filter((p) => p.kind !== 'cupon').map(({ id, name, kind, type, value, requiresPaymentMethodId }) => ({ id, name, kind, type, value, requiresPaymentMethodId })),
    settings: { decoradorTagId: settings.decoradorTagId },
  };
}));

// ---- Productos ----
router.get('/products/search', ...sellers, handle(async (req) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 4) throw httpError('Escribí al menos 4 letras', 400);
  const localId = scopeLocalId(req.posUser, req.query.localId) ?? req.query.localId;
  const [locales, settings] = await Promise.all([getLocales(), getSettings()]);
  const products = await searchCatalog(q, settings);
  const locationIds = stockLocationIds(locales, settings);
  const productIds = products.map((p) => p.productId);
  const [free, reserved] = await Promise.all([fetchFreeStock(productIds, locationIds), readReservationsFor(getDb(), productIds, locationIds)]);
  return products.map((p) => ({
    ...p,
    stock: groupStock({ freeByLoc: free.get(p.productId) ?? new Map(), appReserved: appReservedFor(reserved, p.productId), locales, settings, localId }),
  }));
}));

const images = new Map();
router.get('/products/:templateId/image', async (req, res) => {
  try {
    const id = Number(req.params.templateId);
    if (!id) return res.status(400).end();
    let image = images.get(id);
    if (!image) {
      image = await fetchProductImage(id, 'image_256');
      if (!image || !String(image.contentType).startsWith('image/')) return res.status(404).end();
      images.set(id, image);
      if (images.size > 800) images.delete(images.keys().next().value);
    }
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(image.buffer);
  } catch {
    return res.status(500).end();
  }
});

// ---- Clientes ----
router.get('/customers/lookup', ...sellers, handle(async (req) => {
  const doc = String(req.query.doc ?? '').replace(/\D/g, '');
  if (doc.length < 7) throw new Error('Escribí el DNI o CUIT completo');
  return { odoo: await findPartnerForLookup(doc), arca: null }; // ARCA: Task 14
}));

// ---- Carritos ----
router.get('/carts', ...sellers, handle((req) => orders.listMyCarts(req.posUser)));
router.post('/carts', ...sellers, handle(async (req) => {
  let localId = req.posUser.localId;
  if (isAdminRole(req.posUser.role)) {
    localId = req.body?.localId;
    if (!(await getLocales()).some((l) => l.id === localId)) throw new Error('Elegí un local válido');
  }
  return orders.createCart(actingUser(req, localId), req.body?.line ?? {});
}));
router.post('/carts/:id/lines', ...sellers, handle(async (req) => {
  await orderFor(req);
  return orders.addCartLine(req.params.id, req.posUser, req.body?.line ?? {});
}));
router.delete('/carts/:id', ...sellers, handle(async (req) => {
  await orderFor(req);
  return orders.discardCart(req.params.id, req.posUser);
}));
router.post('/carts/:id/submit', ...sellers, handle(async (req) => {
  await orderFor(req);
  return orders.submitCart(req.params.id, req.posUser, req.body ?? {});
}));

// ---- Líneas (carrito propio o pedido en caja) ----
router.post('/orders/:id/lines', ...cajas, handle(async (req) => {
  const order = await orderFor(req);
  return orders.addCartLine(req.params.id, actingUser(req, order.localId), req.body?.line ?? {});
}));
router.patch('/orders/:id/lines/:lineId', ...sellers, handle(async (req) => {
  const order = await orderFor(req);
  assertLineEditAccess(order, req.posUser);
  return orders.updateLine(req.params.id, actingUser(req, order.localId), req.params.lineId, req.body ?? {});
}));
router.delete('/orders/:id/lines/:lineId', ...sellers, handle(async (req) => {
  const order = await orderFor(req);
  assertLineEditAccess(order, req.posUser);
  return orders.removeLine(req.params.id, actingUser(req, order.localId), req.params.lineId);
}));

// ---- Caja: pedidos ----
router.get('/orders/queue', ...cajas, handle((req) => {
  const localId = scopeLocalId(req.posUser, req.query.localId);
  if (!localId) throw new Error('Elegí el local');
  return orders.listQueue(localId);
}));

router.get('/orders/:id', ...auth, handle(async (req) => {
  const order = await orderFor(req);
  if (!['pendiente', 'error', 'carrito'].includes(order.status)) return { order, preview: null };
  const [methodsById, promotions] = await Promise.all([getPaymentMethodsById(), listActivePromotions()]);
  let preview;
  try {
    preview = orders.priceOrder(order, { methodsById, promotions, now: Date.now() });
  } catch (err) {
    preview = { error: err.message };
  }
  return { order, preview };
}));

router.patch('/orders/:id', ...cajas, handle(async (req) => {
  const order = await orderFor(req);
  return orders.updateDraft(req.params.id, actingUser(req, order.localId), req.body ?? {});
}));

router.post('/orders/:id/confirm', ...cajas, handle(async (req) => {
  const order = await orderFor(req);
  return claimAndConfirmPos(req.params.id, actingUser(req, order.localId));
}));

router.post('/orders/:id/invoice', ...cajas, handle(async (req) => {
  const order = await orderFor(req);
  const locale = (await getLocales()).find((l) => l.id === order.localId);
  if (order.status !== 'confirmado' || !order.wantsInvoice) throw new Error('Este pedido no lleva factura');
  if (order.invoiceName) throw new Error(`Ya tiene la factura ${order.invoiceName}`);
  if (!invoicingEnabledFor(locale)) throw new Error('La facturación de este local no está habilitada');
  const result = await invoicePosOrder(order, locale);
  if (result.status === 'error') throw httpError(result.error, 502);
  return orders.getOrder(order.id);
}));

router.post('/orders/:id/annul', ...cajas, handle(async (req) => {
  const order = await orderFor(req);
  const user = actingUser(req, order.localId);
  if (order.status === 'confirmado') return annulPosOrder(order.id, user, req.body?.reason);
  const inOdoo = order.odooOrderId || order.odooOrders?.length;
  if (!['pendiente', 'error'].includes(order.status) || inOdoo) {
    throw new Error('El pedido ya existe en Odoo: resolvelo en Odoo');
  }
  return orders.markOrderAnnulled(order.id, user.name, req.body?.reason);
}));

router.get('/history', ...cajas, handle(async (req) => {
  const localId = scopeLocalId(req.posUser, req.query.localId);
  const localIds = localId ? [localId] : localeIdsOf(await getLocales());
  const months = String(req.query.months ?? '').split(',').filter((m) => /^\d{4}-\d{2}$/.test(m));
  if (!months.length) throw new Error('Elegí al menos un mes');
  return orders.listOrdersByMonth(localIds, months.slice(0, 6));
}));

// ---- Caja del día ----
const cashLocal = (req) => {
  const localId = scopeLocalId(req.posUser, req.query.localId ?? req.body?.localId);
  if (!localId) throw new Error('Elegí el local');
  return localId;
};
router.get('/cash/current', ...cajas, handle((req) => cash.getCurrentCash(cashLocal(req))));
router.post('/cash/open', ...cajas, handle((req) => cash.openCashSession({ localId: cashLocal(req), openingCash: req.body?.openingCash, user: req.posUser.name })));
router.post('/cash/close', ...cajas, handle((req) => cash.closeCashSession({ localId: cashLocal(req), countedCash: req.body?.countedCash, notes: req.body?.notes, user: req.posUser.name })));
router.post('/cash/movements', ...cajas, handle((req) => cash.addCashMovement(cashLocal(req), req.body ?? {}, req.posUser.name)));
router.post('/cash/movements/:movementId/void', ...cajas, handle((req) => cash.voidOpenCashMovement(cashLocal(req), req.params.movementId, req.posUser.name)));
router.patch('/cash/notes', ...cajas, handle((req) => cash.updateCashNotes(cashLocal(req), req.body?.notes)));
router.get('/cash/sessions', ...cajas, handle((req) => cash.listCashSessions(scopeLocalId(req.posUser, req.query.localId))));

// ---- Admin ----
const LOCALE_ID = /^[A-Z]{2,4}$/;
const CONFIG_ID = /^[A-Za-z0-9_-]{1,40}$/;
const validId = (pattern, label) => (req, res, next) => {
  if (!pattern.test(req.params.id)) return res.status(400).json({ error: `${label} inválido` });
  return next();
};

router.get('/admin/options', ...admins, handle(() => listOdooOptions()));
router.get('/admin/locales', ...admins, handle(() => getLocales()));
router.put('/admin/locales/:id', ...admins, validId(LOCALE_ID, 'Código de local'), handle(async (req) => { await saveLocale(req.params.id, req.body ?? {}); return getLocales(); }));
router.get('/admin/settings', ...admins, handle(() => getSettings()));
router.put('/admin/settings', ...admins, handle(async (req) => { await saveSettings(req.body ?? {}); return getSettings(); }));
router.get('/admin/payment-methods', ...admins, handle(() => getPaymentMethods()));
router.put('/admin/payment-methods/:id', ...admins, validId(CONFIG_ID, 'Id de medio de pago'), handle(async (req) => { await savePaymentMethod(req.params.id, req.body ?? {}); return getPaymentMethods(); }));
router.get('/admin/promotions', ...admins, handle(() => listPromotions()));
router.post('/admin/promotions', ...admins, handle(async (req) => ({ id: await savePromotion(null, req.body ?? {}) })));
router.put('/admin/promotions/:id', ...admins, validId(CONFIG_ID, 'Id de promoción'), handle(async (req) => ({ id: await savePromotion(req.params.id, req.body ?? {}) })));
router.get('/admin/users', ...admins, handle(() => listUsers()));
router.post('/admin/users', ...admins, handle(async (req) => createUser(req.body ?? {}, req.posUser, localeIdsOf(await getLocales()))));
router.patch('/admin/users/:id', ...admins, handle(async (req) => updateUser(req.params.id, req.body ?? {}, req.posUser, localeIdsOf(await getLocales()))));
router.delete('/admin/users/:id', ...admins, handle((req) => deleteUser(req.params.id, req.posUser)));
router.get('/admin/stats', ...admins, handle(async (req) => {
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('Rango de fechas inválido');
  const localIds = req.query.localId ? [req.query.localId] : localeIdsOf(await getLocales());
  const all = await orders.listOrdersByMonth(localIds, monthsBetween(from, to));
  return computePosStats(all, { from: from.getTime(), to: to.getTime() });
}));

export default router;
