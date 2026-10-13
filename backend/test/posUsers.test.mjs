import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.POS_AUTH_SECRET = 'test-secret-pos';
const { validateUserInput, assertCanManage } = await import('../posUsers.mjs');
const { hashSecret } = await import('../posAuth.mjs');

const localeIds = ['LL', 'BL', 'AL'];

test('vendedor: necesita nombre, local y PIN de 4 a 6 números', () => {
  const errors = validateUserInput({ role: 'vendedor', name: '', localId: 'XX', pin: '12' }, { isNew: true, users: [], localeIds });
  assert.deepEqual(errors, ['Falta el nombre', 'Local inválido', 'El PIN tiene que tener de 4 a 6 números']);
});

test('vendedor: el PIN no se puede repetir con otro vendedor', () => {
  const users = [{ id: 'a', role: 'vendedor', pinHash: hashSecret('1234') }];
  const errors = validateUserInput({ role: 'vendedor', name: 'Ana', localId: 'LL', pin: '1234' }, { isNew: true, users, localeIds });
  assert.deepEqual(errors, ['Ese PIN ya lo usa otro vendedor']);
  assert.deepEqual(validateUserInput({ role: 'vendedor', name: 'Ana', localId: 'LL', pin: '1234' }, { isNew: false, users, localeIds, selfId: 'a' }), []);
});

test('caja: usuario y contraseña (mín. 6) al crear; local obligatorio', () => {
  const errors = validateUserInput({ role: 'caja', name: 'Caja Lomas', username: '', password: '123' }, { isNew: true, users: [], localeIds });
  assert.deepEqual(errors, ['Local inválido', 'Falta el usuario', 'La contraseña tiene que tener al menos 6 caracteres']);
});

test('caja: al editar, la contraseña vacía deja la que tenía', () => {
  const errors = validateUserInput({ role: 'caja', name: 'Caja', username: 'caja.lomas', localId: 'LL' }, { isNew: false, users: [], localeIds, selfId: 'c' });
  assert.deepEqual(errors, []);
});

test('usuario repetido → error', () => {
  const users = [{ id: 'x', role: 'caja', username: 'caja.lomas' }];
  const errors = validateUserInput({ role: 'admin', name: 'Fac', username: 'Caja.Lomas', password: '123456' }, { isNew: true, users, localeIds });
  assert.deepEqual(errors, ['Ese usuario ya existe']);
});

test('assertCanManage: admin maneja vendedor y caja; solo superadmin maneja admins', () => {
  assert.doesNotThrow(() => assertCanManage({ role: 'admin' }, 'caja'));
  assert.throws(() => assertCanManage({ role: 'admin' }, 'admin'), /super admin/);
  assert.doesNotThrow(() => assertCanManage({ role: 'superadmin' }, 'superadmin'));
  assert.throws(() => assertCanManage({ role: 'caja' }, 'vendedor'), /permiso/);
});
