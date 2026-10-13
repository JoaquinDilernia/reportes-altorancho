// Sesiones del punto de venta de locales. Mismo esquema de token que la
// feria (payload + HMAC), pero con su propio secreto y marcado app: 'pos':
// un token de la feria nunca abre el POS ni al revés.
import 'dotenv/config';
import crypto from 'node:crypto';
import { getDb } from './firestore.mjs';

const TTL_SECONDS = 60 * 60 * 12; // un turno largo de local
export const USERS_COLLECTION = 'pos_users';
export const ROLES = ['vendedor', 'caja', 'admin', 'superadmin'];

function secret() {
  const value = process.env.POS_AUTH_SECRET;
  if (!value) throw new Error('Falta POS_AUTH_SECRET');
  return value;
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// PIN y contraseñas se guardan como HMAC con el secreto del POS. Es
// determinístico a propósito: el login por PIN busca con un where por hash.
export function hashSecret(value) {
  return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');
}

export function generateToken(data, now = Date.now()) {
  const exp = now + TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ ...data, app: 'pos', exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token, now = Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  try {
    if (!safeEqual(sign(payload), signature)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.app !== 'pos') return null;
    if (typeof decoded.exp !== 'number' || now >= decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

export const isAdminRole = (role) => role === 'admin' || role === 'superadmin';

// superadmin puede todo lo de admin; admin no entra como caja ni vendedor.
export function hasRole(user, roles) {
  if (!user) return false;
  if (roles.includes(user.role)) return true;
  return user.role === 'superadmin' && roles.includes('admin');
}

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// Local sobre el que opera el pedido: vendedor y caja, siempre el suyo;
// admin, el que pida (o null = todos).
export function scopeLocalId(user, requestedLocalId) {
  if (isAdminRole(user.role)) return requestedLocalId || null;
  if (!user.localId) throw forbidden('Tu usuario no tiene local asignado');
  if (requestedLocalId && requestedLocalId !== user.localId) throw forbidden('No tenés acceso a ese local');
  return user.localId;
}

// Quién puede ver/tocar un pedido: admin todo; vendedor solo sus carritos;
// caja los pedidos de su local.
export function assertOrderAccess(order, user) {
  if (isAdminRole(user.role)) return;
  if (user.role === 'vendedor') {
    if (order.sellerId !== user.id) throw forbidden('Ese pedido es de otro vendedor');
    return;
  }
  if (order.localId !== user.localId) throw forbidden('No tenés acceso a ese local');
}

// Editar líneas: el vendedor solo mientras el pedido es su carrito.
export function assertLineEditAccess(order, user) {
  assertOrderAccess(order, user);
  if (user.role === 'vendedor' && order.status !== 'carrito') throw forbidden('El pedido ya está en caja');
}

export function sessionUser(id, data) {
  return { id, name: data.name, role: data.role, localId: data.localId ?? null };
}

export async function loginWithPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) return null;
  const snap = await getDb().collection(USERS_COLLECTION).where('pinHash', '==', hashSecret(pin)).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.role !== 'vendedor' || data.active === false) return null;
  return sessionUser(doc.id, data);
}

export async function loginWithPassword(username, password) {
  const name = String(username ?? '').toLowerCase().trim();
  if (!name || !password) return null;
  const snap = await getDb().collection(USERS_COLLECTION).where('username', '==', name).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.role === 'vendedor' || data.active === false) return null;
  if (!safeEqual(data.passwordHash, hashSecret(password))) return null;
  return sessionUser(doc.id, data);
}

// Primer superadmin, desde variables de entorno (sin contraseñas en el código).
export async function seedSuperadminIfNeeded() {
  const username = process.env.POS_SUPERADMIN_USERNAME?.toLowerCase().trim();
  const password = process.env.POS_SUPERADMIN_INITIAL_PASSWORD;
  if (!username || !password) return;
  const db = getDb();
  const existing = await db.collection(USERS_COLLECTION).where('role', '==', 'superadmin').limit(1).get();
  if (!existing.empty) return;
  await db.collection(USERS_COLLECTION).add({
    name: process.env.POS_SUPERADMIN_NAME || username, username, role: 'superadmin', localId: null,
    passwordHash: hashSecret(password), active: true, createdAt: new Date(),
  });
  console.log('[pos] superadmin inicial creado:', username);
}

export function requirePosAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'No autenticado' });
  req.posUser = { id: decoded.id, name: decoded.name, role: decoded.role, localId: decoded.localId ?? null };
  next();
}

export function requirePosRole(...roles) {
  return (req, res, next) => {
    if (!hasRole(req.posUser, roles)) return res.status(403).json({ error: 'Acceso restringido' });
    next();
  };
}
