// Usuarios de la feria, administrados desde la app por el super admin:
// vendedores (nombre, PIN, número para el prefijo del pedido) y usuarios de
// caja / logística (usuario y contraseña). Logística entra solo a su panel.
import { getDb } from './firestore.mjs';
import { hashPassword, SUPERADMIN_EMAIL, adminRoleOf } from './feriaAuth.mjs';

export { SUPERADMIN_EMAIL, adminRoleOf };

const SELLERS = 'feria_sellers';
const ADMINS = 'feria_admins';
// Caja no ve estadísticas, rebajas ni usuarios; el super admin ve todo.
export const ADMIN_ROLES = { caja: 'Caja', logistica: 'Logística', superadmin: 'Super admin' };
// El usuario de caja es un email (los primeros) o un nombre.apellido.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,}$/;

// "María Castera" → "maria.castera": el usuario de caja sale del nombre.
export function usernameFromName(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

// `sellers`: los vendedores actuales; `selfId`: el que se está editando (puede
// conservar su PIN y número).
export function validateSellerInput({ name, pin, code }, sellers, selfId = null) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw new Error('Falta el nombre del vendedor');
  const cleanPin = String(pin ?? '').trim();
  if (!/^\d{4,8}$/.test(cleanPin)) throw new Error('El PIN tiene que tener de 4 a 8 números');
  const cleanCode = String(code ?? '').trim();
  if (!/^[1-9]\d{0,2}$/.test(cleanCode)) throw new Error('El número de vendedor tiene que ser un número de 1 a 999');
  const others = sellers.filter((s) => s.id !== selfId);
  const samePin = others.find((s) => String(s.pin) === cleanPin);
  if (samePin) throw new Error(`Ese PIN ya lo usa ${samePin.name}: elegí otro`);
  const sameCode = others.find((s) => String(s.code ?? '') === cleanCode);
  if (sameCode) throw new Error(`El número ${cleanCode} ya lo tiene ${sameCode.name}: elegí otro`);
  return { name: cleanName, pin: cleanPin, code: cleanCode };
}

export function validateAdminInput({ email, name, password, role }, { isNew }) {
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(cleanEmail) && !USERNAME_PATTERN.test(cleanEmail)) {
    throw new Error('Usuario inválido: tiene que ser un email o nombre.apellido');
  }
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw new Error('Falta el nombre');
  if (!ADMIN_ROLES[role]) throw new Error('Rol inválido: tiene que ser caja, logística o super admin');
  const cleanPassword = password ? String(password) : null;
  if ((isNew || cleanPassword) && (!cleanPassword || cleanPassword.length < 6)) {
    throw new Error('La contraseña tiene que tener al menos 6 caracteres');
  }
  return { email: cleanEmail, name: cleanName, password: cleanPassword, role };
}

// Carga masiva (scripts/createFeriaUsers.mjs): a cada vendedor nuevo le toca
// un PIN de 4 números al azar que nadie más tenga y el número siguiente al
// más alto; a cada usuario de caja, nombre.apellido y una contraseña al azar.
// Los que ya existen (mismo nombre / mismo usuario) se saltean. `random(n)`
// devuelve un entero en [0, n).
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sin l/1/o/0/i
const PASSWORD_LENGTH = 8;

export function planBulkUsers({ sellerNames = [], cajaNames = [] }, { sellers, adminIds }, random) {
  const sameName = (a, b) => usernameFromName(a) === usernameFromName(b);
  const usedPins = new Set(sellers.map((s) => String(s.pin)));
  let nextCode = Math.max(0, ...sellers.map((s) => Number(s.code) || 0)) + 1;

  const newSellers = [];
  const skippedSellers = [];
  for (const raw of sellerNames) {
    const name = String(raw).trim();
    if (!name) continue;
    if ([...sellers, ...newSellers].some((s) => sameName(s.name, name))) { skippedSellers.push(name); continue; }
    if (usedPins.size >= 9000) throw new Error('No quedan PINs de 4 números libres');
    let pin;
    do { pin = String(1000 + random(9000)); } while (usedPins.has(pin));
    usedPins.add(pin);
    newSellers.push({ name, pin, code: String(nextCode++) });
  }

  const takenIds = new Set(adminIds);
  const newAdmins = [];
  const skippedAdmins = [];
  for (const raw of cajaNames) {
    const name = String(raw).trim();
    if (!name) continue;
    const email = usernameFromName(name);
    if (takenIds.has(email)) { skippedAdmins.push(name); continue; }
    takenIds.add(email);
    const password = Array.from({ length: PASSWORD_LENGTH }, () => PASSWORD_ALPHABET[random(PASSWORD_ALPHABET.length)]).join('');
    newAdmins.push(validateAdminInput({ email, name, password, role: 'caja' }, { isNew: true }));
  }

  return { newSellers, skippedSellers, newAdmins, skippedAdmins };
}

// ---- Firestore ----

async function allSellers() {
  const snap = await getDb().collection(SELLERS).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listUsers() {
  const sellers = (await allSellers())
    .map(({ id, name, pin, code, test }) => ({ id, name, pin, code: code ?? null, test: !!test }))
    .sort((a, b) => Number(a.code ?? 999) - Number(b.code ?? 999));
  const adminsSnap = await getDb().collection(ADMINS).get();
  const admins = adminsSnap.docs
    .map((d) => ({
      id: d.id, email: d.data().email ?? d.id, name: d.data().name, role: adminRoleOf(d.id, d.data()),
      test: !!d.data().test, protected: isProtectedAdmin(d.id),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return { sellers, admins };
}

// Para el desplegable del login de caja (ruta pública): solo id y nombre,
// nunca el rol.
export async function listLoginAdmins() {
  const adminsSnap = await getDb().collection(ADMINS).get();
  return adminsSnap.docs
    .map((d) => ({ id: d.id, name: d.data().name ?? d.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function createSeller(input) {
  const clean = validateSellerInput(input, await allSellers());
  const ref = getDb().collection(SELLERS).doc();
  await ref.set({ ...clean, createdAt: new Date() });
  return { id: ref.id, ...clean };
}

export async function updateSeller(id, input) {
  const sellers = await allSellers();
  if (!sellers.some((s) => s.id === id)) throw new Error('Vendedor no encontrado');
  const clean = validateSellerInput(input, sellers, id);
  await getDb().collection(SELLERS).doc(id).update({ ...clean, updatedAt: new Date() });
  return { id, ...clean };
}

export async function deleteSeller(id) {
  const ref = getDb().collection(SELLERS).doc(id);
  if (!(await ref.get()).exists) throw new Error('Vendedor no encontrado');
  await ref.delete();
}

export async function createAdmin(input) {
  const clean = validateAdminInput(input, { isNew: true });
  const ref = getDb().collection(ADMINS).doc(clean.email);
  if ((await ref.get()).exists) throw new Error(`Ya existe un usuario con ${clean.email}`);
  await ref.set({ email: clean.email, name: clean.name, role: clean.role, passwordHash: hashPassword(clean.password), createdAt: new Date() });
  return { id: clean.email, email: clean.email, name: clean.name, role: clean.role };
}

// El super admin no se edita ni se borra desde acá (no se puede quedar sin él).
// El super admin original no se edita ni se borra: así nunca se pierde el
// acceso a la administración. Los demás super admin sí.
export function isProtectedAdmin(id) {
  return id === SUPERADMIN_EMAIL;
}

async function editableAdmin(id) {
  const ref = getDb().collection(ADMINS).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Usuario no encontrado');
  if (isProtectedAdmin(id)) throw new Error('El super admin principal no se modifica desde acá');
  return { ref, data: snap.data() };
}

export async function updateAdmin(id, input) {
  const { ref } = await editableAdmin(id);
  const clean = validateAdminInput({ ...input, email: id }, { isNew: false });
  const update = { name: clean.name, role: clean.role, updatedAt: new Date() };
  if (clean.password) update.passwordHash = hashPassword(clean.password);
  await ref.update(update);
  return { id, email: id, name: clean.name, role: clean.role };
}

export async function deleteAdmin(id) {
  const { ref } = await editableAdmin(id);
  await ref.delete();
}
