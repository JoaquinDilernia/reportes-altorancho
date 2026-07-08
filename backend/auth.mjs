import 'dotenv/config';
import crypto from 'node:crypto';

const SECRET = process.env.AUTH_SECRET;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días, dashboard de un solo usuario

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateToken(expiresInSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Date.now() + expiresInSeconds * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;

  const [payload, signature] = token.split('.');

  try {
    if (!safeEqual(sign(payload), signature)) return false;
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyToken(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}
