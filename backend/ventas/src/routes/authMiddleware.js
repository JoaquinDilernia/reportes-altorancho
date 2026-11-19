import crypto from 'node:crypto';

// Auth simple de un solo usuario: el dashboard manda la contraseña como Bearer token
// y acá se compara (timing-safe) contra DASHBOARD_PASSWORD. Sin Firebase Auth.
export function createAuthMiddleware({ password }) {
  if (!password) throw new Error('Falta DASHBOARD_PASSWORD');
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'falta token' });
    const got = Buffer.from(token);
    const ok = got.length === expected.length && crypto.timingSafeEqual(got, expected);
    if (!ok) return res.status(401).json({ error: 'contraseña incorrecta' });
    next();
  };
}
