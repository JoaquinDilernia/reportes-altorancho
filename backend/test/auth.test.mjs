import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-for-unit-tests';
const { generateToken, verifyToken } = await import('../auth.mjs');

test('a freshly generated token verifies as valid', () => {
  const token = generateToken();
  assert.equal(verifyToken(token), true);
});

test('a tampered token fails verification', () => {
  const token = generateToken();
  const tampered = token.slice(0, -2) + 'xx';
  assert.equal(verifyToken(tampered), false);
});

test('an expired token fails verification', () => {
  const token = generateToken(-1); // expiresInSeconds negative => already expired
  assert.equal(verifyToken(token), false);
});

test('garbage input fails verification without throwing', () => {
  assert.equal(verifyToken('not-a-real-token'), false);
  assert.equal(verifyToken(''), false);
  assert.equal(verifyToken(undefined), false);
});

test('verifyToken returns false (not throws) when AUTH_SECRET is unset', async () => {
  // SECRET is captured into a module-level const at import time, so we must
  // load a fresh module instance (via a cache-busting query string) while
  // AUTH_SECRET is unset, rather than mutating the already-imported module.
  const savedSecret = process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET;

  const { verifyToken: verifyTokenNoSecret } = await import(
    `../auth.mjs?no-secret-test=${Date.now()}`
  );

  process.env.AUTH_SECRET = savedSecret;

  assert.doesNotThrow(() => verifyTokenNoSecret('anything.tokenlike'));
  assert.equal(verifyTokenNoSecret('anything.tokenlike'), false);
});
