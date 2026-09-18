import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FERIA_AUTH_SECRET = 'test-secret';
const { generateToken, verifyToken } = await import('../feriaAuth.mjs');

test('generateToken + verifyToken hacen roundtrip con el payload', () => {
  const token = generateToken({ role: 'vendedor', id: 'v1', name: 'Ana' });
  const decoded = verifyToken(token);
  assert.equal(decoded.role, 'vendedor');
  assert.equal(decoded.id, 'v1');
  assert.equal(decoded.name, 'Ana');
});

test('verifyToken devuelve null si el token fue alterado', () => {
  const token = generateToken({ role: 'caja', id: 'c1', name: 'Joaquín' });
  const tampered = token.slice(0, -2) + 'xx';
  assert.equal(verifyToken(tampered), null);
});

test('verifyToken devuelve null para un token con formato inválido', () => {
  assert.equal(verifyToken('esto-no-es-un-token'), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken(null), null);
});
