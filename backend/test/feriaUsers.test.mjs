import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoleOf, validateSellerInput, validateAdminInput, SUPERADMIN_EMAIL, isProtectedAdmin } from '../feriaUsers.mjs';

const sellers = [
  { id: 's1', name: 'Ana', pin: '1111', code: '1' },
  { id: 's2', name: 'Beto', pin: '2222', code: '2' },
];

test('adminRoleOf: el rol guardado; sin rol, el super admin por su email y el resto caja', () => {
  assert.equal(adminRoleOf(SUPERADMIN_EMAIL, {}), 'superadmin');
  assert.equal(adminRoleOf('x@altorancho.com', {}), 'caja');
  assert.equal(adminRoleOf('x@altorancho.com', { role: 'logistica' }), 'logistica');
});

test('validateSellerInput: nombre, PIN de 4 a 8 números y número de vendedor, sin repetir', () => {
  assert.deepEqual(validateSellerInput({ name: ' Carla ', pin: '3333', code: 3 }, sellers), { name: 'Carla', pin: '3333', code: '3' });
  assert.throws(() => validateSellerInput({ name: '', pin: '3333', code: 3 }, sellers), /nombre/);
  assert.throws(() => validateSellerInput({ name: 'C', pin: '12', code: 3 }, sellers), /PIN/);
  assert.throws(() => validateSellerInput({ name: 'C', pin: '12ab', code: 3 }, sellers), /PIN/);
  assert.throws(() => validateSellerInput({ name: 'C', pin: '1111', code: 3 }, sellers), /PIN ya lo usa Ana/);
  assert.throws(() => validateSellerInput({ name: 'C', pin: '3333', code: 2 }, sellers), /número 2 ya lo tiene Beto/);
  assert.throws(() => validateSellerInput({ name: 'C', pin: '3333', code: 0 }, sellers), /número de vendedor/);
});

test('validateSellerInput: al editar, el mismo vendedor puede conservar su PIN y número', () => {
  assert.deepEqual(validateSellerInput({ name: 'Ana', pin: '1111', code: '1' }, sellers, 's1'), { name: 'Ana', pin: '1111', code: '1' });
});

test('validateAdminInput: email, nombre, rol caja o logística; contraseña obligatoria al crear', () => {
  assert.deepEqual(validateAdminInput({ email: ' Caja1@AltoRancho.com ', name: 'Caja 1', password: 'secreta1', role: 'caja' }, { isNew: true }),
    { email: 'caja1@altorancho.com', name: 'Caja 1', password: 'secreta1', role: 'caja' });
  assert.throws(() => validateAdminInput({ email: 'nada', name: 'X', password: 'secreta1', role: 'caja' }, { isNew: true }), /Email/);
  assert.throws(() => validateAdminInput({ email: 'a@b.com', name: 'X', password: '123', role: 'caja' }, { isNew: true }), /6 caracteres/);
  assert.throws(() => validateAdminInput({ email: 'a@b.com', name: 'X', password: 'secreta1', role: 'jefe' }, { isNew: true }), /Rol/);
  // Al editar, sin contraseña nueva se conserva la actual.
  assert.deepEqual(validateAdminInput({ email: 'a@b.com', name: 'X', role: 'logistica' }, { isNew: false }),
    { email: 'a@b.com', name: 'X', password: null, role: 'logistica' });
});

test('validateAdminInput: el super admin puede dar el rol super admin a otros', () => {
  assert.equal(validateAdminInput({ email: 'jefa@altorancho.com', name: 'Jefa', password: 'secreta1', role: 'superadmin' }, { isNew: true }).role, 'superadmin');
});

test('isProtectedAdmin: solo el super admin original no se edita ni se borra', () => {
  assert.equal(isProtectedAdmin(SUPERADMIN_EMAIL), true);
  assert.equal(isProtectedAdmin('jefa@altorancho.com'), false);
});
