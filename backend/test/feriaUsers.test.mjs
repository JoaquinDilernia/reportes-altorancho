import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoleOf, validateSellerInput, validateAdminInput, SUPERADMIN_EMAIL, isProtectedAdmin, usernameFromName, planBulkUsers } from '../feriaUsers.mjs';

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
  assert.throws(() => validateAdminInput({ email: 'no válido', name: 'X', password: 'secreta1', role: 'caja' }, { isNew: true }), /Usuario inválido/);
  assert.throws(() => validateAdminInput({ email: 'a@b.com', name: 'X', password: '123', role: 'caja' }, { isNew: true }), /6 caracteres/);
  assert.throws(() => validateAdminInput({ email: 'a@b.com', name: 'X', password: 'secreta1', role: 'jefe' }, { isNew: true }), /Rol/);
  // Al editar, sin contraseña nueva se conserva la actual.
  assert.deepEqual(validateAdminInput({ email: 'a@b.com', name: 'X', role: 'logistica' }, { isNew: false }),
    { email: 'a@b.com', name: 'X', password: null, role: 'logistica' });
});

test('validateAdminInput: el super admin puede dar el rol super admin a otros', () => {
  assert.equal(validateAdminInput({ email: 'jefa@altorancho.com', name: 'Jefa', password: 'secreta1', role: 'superadmin' }, { isNew: true }).role, 'superadmin');
});

test('validateAdminInput: el usuario puede ser nombre.apellido en vez de email', () => {
  assert.equal(validateAdminInput({ email: 'Maria.Castera', name: 'María Castera', password: 'secreta1', role: 'caja' }, { isNew: true }).email, 'maria.castera');
  assert.throws(() => validateAdminInput({ email: 'a b', name: 'X', password: 'secreta1', role: 'caja' }, { isNew: true }), /Usuario inválido/);
});

test('usernameFromName: sin tildes, en minúscula y con puntos', () => {
  assert.equal(usernameFromName('María Castera'), 'maria.castera');
  assert.equal(usernameFromName('  Jair  Infusino '), 'jair.infusino');
  assert.equal(usernameFromName('Sofía Di Lernia'), 'sofia.di.lernia');
});

test('planBulkUsers: PINs de 4 números únicos, números correlativos y saltea los que ya existen', () => {
  // Un "azar" que repite para forzar el reintento de PIN.
  const seq = [1111 - 1000, 1111 - 1000, 5555 - 1000, 5555 - 1000, 7777 - 1000];
  let i = 0;
  const random = (n) => (n === 9000 ? seq[i++] : 0);
  const plan = planBulkUsers(
    { sellerNames: ['Ana', 'Pedro Ribatto', 'Lucía Pérez', ' ', 'lucia perez'], cajaNames: ['Jair Infusino', 'María Castera'] },
    { sellers, adminIds: ['maria.castera'] },
    random,
  );
  assert.deepEqual(plan.skippedSellers, ['Ana', 'lucia perez']);
  assert.deepEqual(plan.newSellers, [
    { name: 'Pedro Ribatto', pin: '5555', code: '3' }, // 1111 ya es de Ana
    { name: 'Lucía Pérez', pin: '7777', code: '4' },
  ]);
  assert.deepEqual(plan.skippedAdmins, ['María Castera']);
  assert.equal(plan.newAdmins.length, 1);
  assert.equal(plan.newAdmins[0].email, 'jair.infusino');
  assert.equal(plan.newAdmins[0].role, 'caja');
  assert.match(plan.newAdmins[0].password, /^[a-z2-9]{8}$/);
});

test('isProtectedAdmin: solo el super admin original no se edita ni se borra', () => {
  assert.equal(isProtectedAdmin(SUPERADMIN_EMAIL), true);
  assert.equal(isProtectedAdmin('jefa@altorancho.com'), false);
});
