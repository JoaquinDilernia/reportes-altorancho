import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoRetry, autoRetryDelayMs, AUTO_RETRY_MAX } from '../feriaLines.mjs';

const MIN = 60 * 1000;
const t0 = Date.parse('2026-10-01T15:00:00Z');
const failed = (over = {}) => ({ status: 'error', updatedAt: new Date(t0), ...over });

test('autoRetryDelayMs: espera creciente 3, 6, 12, 24 min y tope de 30', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => autoRetryDelayMs(n) / MIN), [3, 6, 12, 24, 30, 30]);
});

test('shouldAutoRetry: un pedido con error se reintenta cuando pasó la espera', () => {
  assert.equal(shouldAutoRetry(failed(), t0 + 2 * MIN), false);
  assert.equal(shouldAutoRetry(failed(), t0 + 3 * MIN), true);
  // Después del primer intento automático, la espera es de 6 minutos.
  const once = failed({ autoRetryCount: 1, lastAutoRetryAt: new Date(t0) });
  assert.equal(shouldAutoRetry(once, t0 + 5 * MIN), false);
  assert.equal(shouldAutoRetry(once, t0 + 6 * MIN), true);
});

test('shouldAutoRetry: no reintenta si no está en error, si se está confirmando o si llegó al tope', () => {
  assert.equal(shouldAutoRetry(failed({ status: 'pendiente' }), t0 + 60 * MIN), false);
  assert.equal(shouldAutoRetry(failed({ confirmingSince: new Date(t0 + 59 * MIN) }), t0 + 60 * MIN), false);
  assert.equal(shouldAutoRetry(failed({ autoRetryCount: AUTO_RETRY_MAX, lastAutoRetryAt: new Date(t0) }), t0 + 600 * MIN), false);
});

test('shouldAutoRetry: acepta Timestamps de Firestore', () => {
  const ts = { toMillis: () => t0 };
  assert.equal(shouldAutoRetry(failed({ updatedAt: ts }), t0 + 3 * MIN), true);
});
