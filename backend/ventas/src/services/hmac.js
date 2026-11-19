import crypto from 'node:crypto';

export function verifyTiendanubeHmac(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
