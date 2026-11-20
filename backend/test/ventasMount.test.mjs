import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createTestDb } from '../ventas/test/helpers/testDb.js';
import { startVentas } from '../ventas/module.mjs';
import { app, mountVentas } from '../index.mjs';
import { generateToken } from '../auth.mjs';

const ENV = {
  TIENDANUBE_STORE_ID: '1', TIENDANUBE_TOKEN: 't', TIENDANUBE_WEBHOOK_SECRET: 's',
  META_ACCESS_TOKEN: 'm', META_ACCOUNT_ID: '1', ANTHROPIC_API_KEY: 'k',
};
const quiet = { log() {}, error() {} };

test('el módulo Ventas corre dentro del servidor de Reportes', async () => {
  const db = await createTestDb();
  const before = await request(app).get('/webhooks/tiendanube');
  assert.equal(before.status, 404); // sin módulo no hay webhooks

  const v = await startVentas(ENV, { db, log: quiet });
  await mountVentas(v);
  const auth = { Authorization: `Bearer ${generateToken(60)}` };

  const sum = await request(app).get('/api/gz/summary?from=2026-11-01&to=2026-11-19').set(auth);
  assert.equal(sum.status, 200);
  assert.equal(sum.body.orders, 0);

  const bad = await request(app).get('/api/gz/summary?from=x&to=y').set(auth);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /YYYY-MM-DD/);

  assert.equal((await request(app).get('/api/gz/no-existe').set(auth)).status, 404);
  assert.equal((await request(app).get('/api/gz/summary?from=2026-11-01&to=2026-11-19')).status, 401);

  // El webhook firma el cuerpo crudo: sin firma válida se rechaza (y no lo frena el login de Reportes)
  const hook = await request(app).post('/webhooks/tiendanube').set('Content-Type', 'application/json').send('{"id":1}');
  assert.equal(hook.status, 401);
  await db.close();
});
