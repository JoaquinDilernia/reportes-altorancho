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

test('scopeLocalId: usuario sin local asignado → 403, nunca "todos"', () => {
  assert.throws(() => scopeLocalId({ role: 'caja', localId: null }, undefined), (err) => err.status === 403);
  assert.throws(() => scopeLocalId({ role: 'vendedor' }, undefined), (err) => err.status === 403);
});

const { assertOrderAccess } = await import('../posAuth.mjs');

test('assertOrderAccess: caja de LL no ve pedidos de AL; admin ve todo; vendedor solo sus carritos', () => {
  const al = { localId: 'AL', sellerId: 'v9', status: 'pendiente' };
  assert.throws(() => assertOrderAccess(al, { role: 'caja', localId: 'LL' }), (err) => err.status === 403);
  assert.doesNotThrow(() => assertOrderAccess(al, { role: 'caja', localId: 'AL' }));
  assert.doesNotThrow(() => assertOrderAccess(al, { role: 'admin' }));
  assert.throws(() => assertOrderAccess(al, { role: 'vendedor', id: 'v1', localId: 'AL' }), (err) => err.status === 403);
  assert.doesNotThrow(() => assertOrderAccess({ ...al, sellerId: 'v1', status: 'carrito' }, { role: 'vendedor', id: 'v1', localId: 'AL' }));
});

const { assertLineEditAccess } = await import('../posAuth.mjs');

test('assertLineEditAccess: vendedor solo edita carritos; caja de su local sí; otro local no', () => {
  const v = { role: 'vendedor', id: 'v1', localId: 'AL' };
  assert.doesNotThrow(() => assertLineEditAccess({ localId: 'AL', sellerId: 'v1', status: 'carrito' }, v));
  assert.throws(() => assertLineEditAccess({ localId: 'AL', sellerId: 'v1', status: 'pendiente' }, v), (e) => e.status === 403);
  assert.doesNotThrow(() => assertLineEditAccess({ localId: 'AL', sellerId: 'v1', status: 'pendiente' }, { role: 'caja', localId: 'AL' }));
  assert.throws(() => assertLineEditAccess({ localId: 'AL', sellerId: 'v1', status: 'pendiente' }, { role: 'caja', localId: 'LL' }), (e) => e.status === 403);
});
