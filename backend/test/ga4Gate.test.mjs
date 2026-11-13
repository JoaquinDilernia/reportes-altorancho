import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGa4Gate } from '../ga4.mjs';
import { withLastGood } from '../eventBehavior.mjs';

const res = (status) => ({ status, ok: status >= 200 && status < 300 });
const tick = () => new Promise(r => setImmediate(r));

test('ga4 gate: nunca hay más de maxConcurrent llamadas en vuelo', async () => {
  const gate = createGa4Gate({ maxConcurrent: 2 });
  let active = 0, peak = 0;
  const pending = [];
  const call = () => gate.run(() => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    pending.push(() => { active--; resolve(res(200)); });
  }));
  const all = Promise.all([call(), call(), call(), call(), call()]);
  while (pending.length || active) { await tick(); pending.shift()?.(); }
  await all;
  assert.equal(peak, 2);
});

test('ga4 gate: después de un 429 no llama más hasta que pasa la pausa', async () => {
  let t = 0;
  const gate = createGa4Gate({ cooldownMs: 1000, now: () => t });
  await gate.run(async () => res(429));
  let called = false;
  await assert.rejects(gate.run(async () => { called = true; return res(200); }), /sin cuota/);
  assert.equal(called, false);
  t = 1001;
  assert.equal((await gate.run(async () => res(200))).status, 200);
});

test('ga4 gate: tres errores de servidor o timeouts seguidos frenan las llamadas', async () => {
  const gate = createGa4Gate({ serverErrorLimit: 3, now: () => 0 });
  await gate.run(async () => res(503));
  await assert.rejects(gate.run(async () => { throw new Error('The operation was aborted due to timeout'); }), /timeout/);
  await gate.run(async () => res(500));
  await assert.rejects(gate.run(async () => res(200)), /sin cuota/);
});

test('ga4 gate: una respuesta buena reinicia la cuenta de errores', async () => {
  const gate = createGa4Gate({ serverErrorLimit: 2, now: () => 0 });
  await gate.run(async () => res(500));
  await gate.run(async () => res(200));
  await gate.run(async () => res(500));
  assert.equal((await gate.run(async () => res(200))).status, 200);
});

test('withLastGood: si GA4 falla devuelve el último resultado bueno marcado stale', async () => {
  const store = new Map();
  const log = () => {};
  assert.deepEqual(await withLastGood('k', async () => ({ a: 1 }), { store, log }), { a: 1 });
  const out = await withLastGood('k', async () => { throw new Error('GA4 429'); }, { store, log });
  assert.equal(out.a, 1);
  assert.equal(out.stale, true);
  assert.ok(out.staleSince);
});

test('withLastGood: sin resultado previo el error sigue de largo', async () => {
  await assert.rejects(withLastGood('nuevo', async () => { throw new Error('GA4 429'); }, { store: new Map(), log: () => {} }), /429/);
});
