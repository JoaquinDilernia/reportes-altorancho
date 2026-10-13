import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.POS_AUTH_SECRET = 'test-secret-pos';
process.env.FERIA_AUTH_SECRET = 'test-secret-feria';
const { generateToken, verifyToken, hasRole, scopeLocalId, isAdminRole } = await import('../posAuth.mjs');
const feria = await import('../feriaAuth.mjs');

test('verifyToken: acepta un token del POS y devuelve sus datos', () => {
  const token = generateToken({ id: 'u1', role: 'caja', localId: 'LL', name: 'Ana' });
  const decoded = verifyToken(token);
  assert.equal(decoded.id, 'u1');
  assert.equal(decoded.localId, 'LL');
  assert.equal(decoded.app, 'pos');
});

test('verifyToken: rechaza un token vencido', () => {
  const token = generateToken({ id: 'u1', role: 'caja' }, 0);
  assert.equal(verifyToken(token, 13 * 60 * 60 * 1000), null);
});

test('verifyToken: un token de la feria no sirve en el POS', () => {
  const token = feria.generateToken({ role: 'caja', id: 'x' });
  assert.equal(verifyToken(token), null);
});

test('verifyToken: basura y firma alterada → null', () => {
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('abc'), null);
  const [payload] = generateToken({ id: 'u1', role: 'admin' }).split('.');
  assert.equal(verifyToken(`${payload}.firmafalsa`), null);
});

test('hasRole: superadmin cuenta como admin, no como caja', () => {
  assert.equal(hasRole({ role: 'superadmin' }, ['admin']), true);
  assert.equal(hasRole({ role: 'superadmin' }, ['caja']), false);
  assert.equal(hasRole({ role: 'caja' }, ['caja', 'admin']), true);
  assert.equal(isAdminRole('admin'), true);
  assert.equal(isAdminRole('vendedor'), false);
});

test('scopeLocalId: caja y vendedor quedan en su local; pedir otro es 403', () => {
  assert.equal(scopeLocalId({ role: 'caja', localId: 'LL' }, undefined), 'LL');
  assert.equal(scopeLocalId({ role: 'vendedor', localId: 'LL' }, 'LL'), 'LL');
  assert.throws(() => scopeLocalId({ role: 'caja', localId: 'LL' }, 'AL'), (err) => err.status === 403);
});

test('scopeLocalId: admin elige el local o ve todos (null)', () => {
  assert.equal(scopeLocalId({ role: 'admin' }, 'AL'), 'AL');
  assert.equal(scopeLocalId({ role: 'superadmin' }, undefined), null);
});
