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
  //
  // auth.mjs does `import 'dotenv/config'`, and backend/.env defines a real
  // AUTH_SECRET. dotenv only skips keys already present in process.env, so a
  // bare `delete process.env.AUTH_SECRET` would get silently repopulated from
  // .env when the fresh module's own dotenv preload re-runs. Pointing
  // DOTENV_CONFIG_PATH at a nonexistent file prevents that reload from
  // finding anything, so AUTH_SECRET genuinely stays unset.
  const originalPath = process.env.DOTENV_CONFIG_PATH;
  const originalSecret = process.env.AUTH_SECRET;
  process.env.DOTENV_CONFIG_PATH = '/nonexistent/path/.env.does-not-exist';
  delete process.env.AUTH_SECRET;

  try {
    const { verifyToken: verifyTokenNoSecret } = await import(
      `../auth.mjs?no-secret-test=${Date.now()}`
    );

    // Concrete proof dotenv did NOT repopulate AUTH_SECRET from backend/.env
    // during the fresh module's `import 'dotenv/config'` line above. Without
    // this assertion the test would silently pass for the wrong reason (a
    // real secret mismatch) instead of exercising the catch-guarded path.
    assert.equal(process.env.AUTH_SECRET, undefined);

    assert.doesNotThrow(() => verifyTokenNoSecret('anything.tokenlike'));
    assert.equal(verifyTokenNoSecret('anything.tokenlike'), false);
  } finally {
    if (originalPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = originalPath;
    process.env.AUTH_SECRET = originalSecret;
  }
});
