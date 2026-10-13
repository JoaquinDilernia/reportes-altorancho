import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.POS_AUTH_SECRET = 'test-secret-pos';
process.env.FERIA_AUTH_SECRET = 'test-secret-feria';
const { default: posRoutes, createLoginLimiter } = await import('../posRoutes.mjs');
const feria = await import('../feriaAuth.mjs');
const { generateToken } = await import('../posAuth.mjs');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/pos', posRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/pos`;
  try { await fn(base); } finally { server.close(); }
}

test('sin token → 401; token de la feria → 401', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/orders/queue`)).status, 401);
    const feriaToken = feria.generateToken({ role: 'caja', id: 'x' });
    const res = await fetch(`${base}/orders/queue`, { headers: { Authorization: `Bearer ${feriaToken}` } });
    assert.equal(res.status, 401);
  });
});

test('vendedor no entra a rutas de admin ni de caja → 403', async () => {
  await withServer(async (base) => {
    const token = generateToken({ id: 'v1', role: 'vendedor', localId: 'LL', name: 'Ana' });
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/admin/users`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/orders/queue`, { headers })).status, 403);
  });
});

test('búsqueda con menos de 4 letras → 400 sin tocar Odoo', async () => {
  await withServer(async (base) => {
    const token = generateToken({ id: 'v1', role: 'vendedor', localId: 'LL', name: 'Ana' });
    const res = await fetch(`${base}/products/search?q=ab`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
  });
});

test('ids de admin inválidos → 400 sin tocar Firestore', async () => {
  await withServer(async (base) => {
    const token = generateToken({ id: 'a1', role: 'admin', name: 'Admin' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/admin/locales/x.y`, { method: 'PUT', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/admin/locales/ll`, { method: 'PUT', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/admin/payment-methods/a%2Fb`, { method: 'PUT', headers, body: '{}' })).status, 400);
  });
});

test('createLoginLimiter: bloquea tras 10 fallos, expira la ventana y el éxito resetea', () => {
  let t = 0;
  const limiter = createLoginLimiter({ max: 10, windowMs: 600000, now: () => t });
  for (let i = 0; i < 10; i += 1) { assert.equal(limiter.check('1.1.1.1'), true); limiter.fail('1.1.1.1'); }
  assert.equal(limiter.check('1.1.1.1'), false, 'el 11vo intento queda bloqueado');
  assert.equal(limiter.check('2.2.2.2'), true, 'otra IP no se ve afectada');
  t = 600001;
  assert.equal(limiter.check('1.1.1.1'), true, 'la ventana vencida desbloquea');
  for (let i = 0; i < 9; i += 1) limiter.fail('1.1.1.1');
  limiter.reset('1.1.1.1');
  for (let i = 0; i < 9; i += 1) limiter.fail('1.1.1.1');
  assert.equal(limiter.check('1.1.1.1'), true, 'el éxito reinició el contador');
});
