import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.POS_AUTH_SECRET = 'test-secret-pos';
process.env.FERIA_AUTH_SECRET = 'test-secret-feria';
const { default: posRoutes, createLoginLimiter, publicLocale } = await import('../posRoutes.mjs');
const feria = await import('../feriaAuth.mjs');
const { generateToken } = await import('../posAuth.mjs');
const { DEFAULT_SETTINGS } = await import('../posConfig.mjs');

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

const { statusOf, throttledAttempt } = await import('../posRoutes.mjs');

test('statusOf: 404 por no encontrado, 502 por Odoo/red, 400 por defecto', () => {
  assert.equal(statusOf(new Error('Pedido no encontrado')), 404);
  assert.equal(statusOf(new Error('Usuario no encontrado')), 404);
  assert.equal(statusOf(new Error('Promoción no encontrada')), 404);
  assert.equal(statusOf(new Error('Odoo RPC error: boom')), 502);
  assert.equal(statusOf(Object.assign(new TypeError('fetch failed'))), 502);
  assert.equal(statusOf(Object.assign(new Error('t'), { name: 'TimeoutError' })), 502);
  assert.equal(statusOf(Object.assign(new Error('x'), { status: 403 })), 403);
  assert.equal(statusOf(Object.assign(new Error('x'), { stage: 'claim' })), 409);
  assert.equal(statusOf(new Error('Datos inválidos')), 400);
});

test('throttledAttempt: 11 intentos fallidos en paralelo → el 11vo se bloquea', async () => {
  const limiter = createLoginLimiter({ max: 10, windowMs: 600000, now: () => 0 });
  const results = await Promise.allSettled(Array.from({ length: 11 }, () => throttledAttempt(limiter, '9.9.9.9', async () => { await new Promise((r) => setImmediate(r)); return null; })));
  const blocked = results.filter((r) => r.status === 'rejected' && r.reason.status === 429);
  assert.equal(blocked.length, 1);
  const ok = createLoginLimiter({ max: 2, windowMs: 1000, now: () => 0 });
  await throttledAttempt(ok, 'a', async () => null);
  assert.deepEqual((await throttledAttempt(ok, 'a', async () => ({ id: 1 }))).user, { id: 1 });
  assert.equal(ok.check('a'), true);
  await throttledAttempt(ok, 'a', async () => null);
  assert.equal(ok.check('a'), true, 'el éxito reseteó el contador');
});

test('login limiter: poda entradas vencidas', () => {
  let t = 0;
  const l = createLoginLimiter({ max: 3, windowMs: 100, now: () => t, sweepAt: 2 });
  l.fail('a'); l.fail('b'); l.fail('c');
  t = 500;
  l.fail('d');
  assert.equal(l.size(), 1);
});

test('POST /carts de admin sin localId válido → 400; PUT promoción con id raro → 400', async () => {
  await withServer(async (base) => {
    const token = generateToken({ id: 'a1', role: 'admin', name: 'Admin' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/admin/promotions/a.b`, { method: 'PUT', headers, body: '{}' })).status, 400);
  });
});

test('publicLocale: invoices depende de POS_INVOICING_ENABLED y del diario', () => {
  const prev = process.env.POS_INVOICING_ENABLED;
  const loc = { id: 'LL', name: 'Las Lomas', address: 'x', invoiceJournalId: 32 };
  try {
    process.env.POS_INVOICING_ENABLED = 'true';
    assert.equal(publicLocale(loc, DEFAULT_SETTINGS).invoices, true);
    assert.equal(publicLocale({ ...loc, invoiceJournalId: null }, DEFAULT_SETTINGS).invoices, false);
    process.env.POS_INVOICING_ENABLED = 'false';
    assert.equal(publicLocale(loc, DEFAULT_SETTINGS).invoices, false);
    assert.deepEqual(Object.keys(publicLocale(loc, DEFAULT_SETTINGS)), ['id', 'name', 'address', 'invoices', 'returnDestinations']);
  } finally {
    if (prev === undefined) delete process.env.POS_INVOICING_ENABLED; else process.env.POS_INVOICING_ENABLED = prev;
  }
});
