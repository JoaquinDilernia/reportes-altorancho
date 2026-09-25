import 'dotenv/config';
import crypto from 'node:crypto';
import { getDb } from './feriaOdoo.mjs';

const SECRET = process.env.FERIA_AUTH_SECRET;
const TTL_SECONDS = 60 * 60 * 12; // 12hs — dura un turno del evento
const SELLERS_COLLECTION = 'feria_sellers';
const ADMINS_COLLECTION = 'feria_admins';

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Único usuario que administra a los demás (pestaña Usuarios de Caja).
export const SUPERADMIN_EMAIL = 'joaquin.dilernia@altorancho.com';

// Rol dentro de caja: superadmin, caja o logistica. Los admins creados antes
// de los roles no tienen `role`: el super admin se reconoce por su email y el
// resto es caja.
export function adminRoleOf(id, data) {
  return data.role ?? (id === SUPERADMIN_EMAIL ? 'superadmin' : 'caja');
}

// Mismo esquema de token que auth.mjs (payload + firma HMAC en vez de
// jsonwebtoken, para no sumar una dependencia nueva), extendido para
// llevar rol e identidad en vez de solo la expiración.
export function generateToken(data) {
  const exp = Date.now() + TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ ...data, exp })).toString('base64url');
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  try {
    if (!safeEqual(sign(payload), signature)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded.exp !== 'number' || Date.now() >= decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

// feria_sellers/{id} = { name, pin, code }. Se carga a mano en Firestore
// cuando esté definida la lista real de vendedores. `code` (1, 2, 3…) es el
// prefijo de los números de pedido de ese vendedor (F2-0001).
export async function validateSellerPin(pin) {
  const db = getDb();
  const snap = await db.collection(SELLERS_COLLECTION).where('pin', '==', pin).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, name: doc.data().name };
}

export async function getSellerCode(sellerId) {
  const doc = await getDb().collection(SELLERS_COLLECTION).doc(sellerId).get();
  const code = doc.exists ? String(doc.data().code ?? '').trim() : '';
  if (!code) throw new Error('Tu usuario no tiene número de vendedor asignado: pedíselo a administración');
  return code;
}

export async function validateCajaCredentials(email, password) {
  const db = getDb();
  const id = email.toLowerCase().trim();
  const doc = await db.collection(ADMINS_COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!safeEqual(data.passwordHash, hashPassword(password))) return null;
  return { id, email: data.email, name: data.name, adminRole: adminRoleOf(id, data) };
}

// Primer usuario de caja para poder entrar la primera vez — cambiar la
// contraseña después de correr esto una vez.
export async function seedCajaAdminIfNeeded() {
  const db = getDb();
  const email = SUPERADMIN_EMAIL;
  const doc = await db.collection(ADMINS_COLLECTION).doc(email).get();
  if (doc.exists) return;
  await db.collection(ADMINS_COLLECTION).doc(email).set({
    email, name: 'Joaquín Di Lernia', passwordHash: hashPassword('feria2026'),
    createdAt: new Date(),
  });
  console.log('[feriaAuth] Admin de caja seedeado:', email);
}

export function requireFeriaAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'No autenticado' });
  req.feriaUser = decoded;
  next();
}

// Solo el super admin (administra usuarios).
export function requireSuperadmin(req, res, next) {
  if (req.feriaUser?.role !== 'caja' || req.feriaUser?.adminRole !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el super admin puede hacer esto' });
  }
  next();
}

export function requireFeriaRole(role) {
  return (req, res, next) => {
    if (req.feriaUser?.role !== role) return res.status(403).json({ error: 'Acceso restringido' });
    next();
  };
}
