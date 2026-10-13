// ABM de usuarios del POS. Vendedores entran con PIN; caja y admin con
// usuario y contraseña. Admin maneja vendedores y cajas; solo el superadmin
// maneja admins.
import { getDb } from './firestore.mjs';
import { USERS_COLLECTION, ROLES, hashSecret, isAdminRole } from './posAuth.mjs';

const PASSWORD_ROLES = new Set(['caja', 'admin', 'superadmin']);

export function validateUserInput(input, { isNew, users, localeIds, selfId = null }) {
  const errors = [];
  const role = input.role;
  if (!ROLES.includes(role)) return ['Rol inválido'];
  if (!String(input.name ?? '').trim()) errors.push('Falta el nombre');
  if ((role === 'vendedor' || role === 'caja') && !localeIds.includes(input.localId)) errors.push('Local inválido');
  const others = users.filter((u) => u.id !== selfId);
  if (role === 'vendedor') {
    const pin = String(input.pin ?? '');
    if (isNew || pin) {
      if (!/^\d{4,6}$/.test(pin)) errors.push('El PIN tiene que tener de 4 a 6 números');
      else if (others.some((u) => u.role === 'vendedor' && u.pinHash === hashSecret(pin))) errors.push('Ese PIN ya lo usa otro vendedor');
    }
  }
  if (PASSWORD_ROLES.has(role)) {
    const username = String(input.username ?? '').toLowerCase().trim();
    if (!username) errors.push('Falta el usuario');
    else if (others.some((u) => u.username === username)) errors.push('Ese usuario ya existe');
    const password = String(input.password ?? '');
    if ((isNew || password) && password.length < 6) errors.push('La contraseña tiene que tener al menos 6 caracteres');
  }
  return errors;
}

export function assertCanManage(actor, targetRole) {
  if (!isAdminRole(actor.role)) throw Object.assign(new Error('No tenés permiso para manejar usuarios'), { status: 403 });
  if (isAdminRole(targetRole) && actor.role !== 'superadmin') {
    throw Object.assign(new Error('Solo el super admin maneja usuarios admin'), { status: 403 });
  }
}

// Tiene que quedar al menos un super admin activo. next = { role, active } del
// usuario tras el cambio, o null si se borra.
export function assertSuperadminRemains(users, targetId, next) {
  const remaining = users.filter((u) => {
    const isTarget = u.id === targetId;
    const role = isTarget ? next?.role : u.role;
    const active = isTarget ? next?.active : u.active;
    return role === 'superadmin' && active !== false;
  });
  if (remaining.length === 0) throw new Error('Tiene que quedar al menos un super admin activo');
}

function publicUser(id, data) {
  return {
    id, name: data.name, role: data.role, localId: data.localId ?? null,
    username: data.username ?? null, active: data.active !== false,
  };
}

async function readAll() {
  const snap = await getDb().collection(USERS_COLLECTION).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listUsers() {
  return (await readAll())
    .map((u) => publicUser(u.id, u))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function toDoc(input, existing = {}) {
  const doc = {
    name: input.name.trim(), role: input.role,
    localId: input.role === 'vendedor' || input.role === 'caja' ? input.localId : null,
    active: input.active === undefined ? (existing.active ?? true) : input.active !== false,
    updatedAt: new Date(),
  };
  if (input.role === 'vendedor') {
    if (input.pin) doc.pinHash = hashSecret(input.pin);
    doc.username = null;
    doc.passwordHash = null;
  } else {
    doc.username = input.username.toLowerCase().trim();
    if (input.password) doc.passwordHash = hashSecret(input.password);
    doc.pinHash = null;
  }
  return { ...existing, ...doc };
}

export async function createUser(input, actor, localeIds) {
  assertCanManage(actor, input.role);
  const errors = validateUserInput(input, { isNew: true, users: await readAll(), localeIds });
  if (errors.length) throw new Error(errors.join('; '));
  const ref = await getDb().collection(USERS_COLLECTION).add({ ...toDoc(input), createdAt: new Date() });
  return { id: ref.id };
}

export async function updateUser(id, input, actor, localeIds) {
  const users = await readAll();
  const current = users.find((u) => u.id === id);
  if (!current) throw new Error('Usuario no encontrado');
  assertCanManage(actor, current.role);
  assertCanManage(actor, input.role);
  const errors = validateUserInput(input, { isNew: false, users, localeIds, selfId: id });
  if (errors.length) throw new Error(errors.join('; '));
  const nextActive = input.active === undefined ? current.active !== false : input.active !== false;
  assertSuperadminRemains(users, id, { role: input.role, active: nextActive });
  const { id: _omit, ...existing } = current;
  await getDb().collection(USERS_COLLECTION).doc(id).set(toDoc(input, existing));
}

export async function deleteUser(id, actor) {
  if (id === actor.id) throw new Error('No podés borrar tu propio usuario');
  const users = await readAll();
  const current = users.find((u) => u.id === id);
  if (!current) throw new Error('Usuario no encontrado');
  assertCanManage(actor, current.role);
  assertSuperadminRemains(users, id, null);
  await getDb().collection(USERS_COLLECTION).doc(id).delete();
}
