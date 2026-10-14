// Configuración del POS de locales, editable desde el panel Admin. Los ids
// de Odoo de los valores iniciales se verificaron el 2026-10-13 (ver spec).
import { getDb } from './firestore.mjs';

const LOCALES = 'pos_locales';
const PAYMENT_METHODS = 'pos_payment_methods';
const SETTINGS_REF = (db) => db.collection('pos_settings').doc('general');
const CACHE_MS = 30 * 1000;

export const DEFAULT_LOCALES = [
  { id: 'LL', name: 'Las Lomas', warehouseId: 1, stockLocationId: 8, exhibicionLocationId: 324, teamId: 6, invoiceJournalId: 32, address: '', active: true },
  { id: 'BL', name: 'Belgrano', warehouseId: 40, stockLocationId: 372, exhibicionLocationId: 379, teamId: 18, invoiceJournalId: 65, address: '', active: true },
  { id: 'AL', name: 'Alcorta', warehouseId: 41, stockLocationId: 397, exhibicionLocationId: 415, teamId: 25, invoiceJournalId: 78, address: '', active: true },
];

export const DEFAULT_SETTINGS = {
  rolon: { warehouseId: 28, locationId: 174, outPickingTypeId: 191 },
  web: { locationId: 150 },
  fullPricelistId: 312,
  orderPricelistId: 314,
  promoPricelistId: 313,
  shippingProductSku: 'EnvioParticular',
  decoradorTagId: 1,
};

const cuotas = (n, name) => ({ id: String(n), label: n === 1 ? '1 cuota' : `${n} cuotas`, odooName: name });

export const DEFAULT_PAYMENT_METHODS = [
  { id: 'efectivo', label: 'Efectivo', discountPct: 15, odooName: 'Efectivo', details: [], order: 1, active: true },
  { id: 'transferencia', label: 'Transferencia', discountPct: 20, odooName: 'Transferencia', details: [], order: 2, active: true },
  { id: 'debito', label: 'Tarjeta débito', discountPct: 0, odooName: 'Mercado Pago Debito', details: [], order: 3, active: true },
  {
    id: 'credito', label: 'Tarjeta crédito', discountPct: 0, odooName: null, order: 4, active: true,
    details: [
      cuotas(1, 'Mercado Pago 1 cuota'), cuotas(3, 'Mercado Pago 3 cuotas'), cuotas(6, 'Mercado Pago 6 cuotas'),
      cuotas(12, 'Mercado Pago 12 cuotas'), cuotas(18, 'Mercado Pago 18 cuotas'),
    ],
  },
  { id: 'gocuotas', label: 'GoCuotas', discountPct: 0, odooName: 'Gocuotas', details: [], order: 5, active: true },
];

const isId = (v) => Number.isInteger(v) && v > 0;

export function validateLocale(input) {
  const errors = [];
  if (!String(input.name ?? '').trim()) errors.push('Falta el nombre');
  if (!isId(input.warehouseId)) errors.push('Depósito inválido');
  if (!isId(input.stockLocationId)) errors.push('Ubicación de stock inválida');
  if (!isId(input.exhibicionLocationId)) errors.push('Ubicación de exhibición inválida');
  if (!isId(input.teamId)) errors.push('Equipo de ventas inválido');
  if (input.invoiceJournalId != null && !isId(input.invoiceJournalId)) errors.push('Diario de facturas inválido');
  return errors;
}

export function validatePaymentMethod(input) {
  const errors = [];
  if (!String(input.label ?? '').trim()) errors.push('Falta el nombre');
  const pct = input.discountPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) errors.push('El descuento tiene que estar entre 0 y 100');
  const details = input.details ?? [];
  if (!details.length && !String(input.odooName ?? '').trim()) errors.push('Falta el medio de pago de Odoo');
  for (const d of details) {
    if (!String(d.label ?? '').trim() || !String(d.odooName ?? '').trim()) errors.push('Cada detalle necesita nombre y medio de Odoo');
  }
  return errors;
}

export function validateSettings(input) {
  const errors = [];
  if (!isId(input.rolon?.warehouseId) || !isId(input.rolon?.locationId)) errors.push('Rolón: depósito y ubicación obligatorios');
  if (input.rolon?.outPickingTypeId != null && !isId(input.rolon.outPickingTypeId)) errors.push('Rolón: tipo de operación inválido');
  if (!isId(input.web?.locationId)) errors.push('Web: ubicación obligatoria');
  for (const key of ['fullPricelistId', 'promoPricelistId', 'orderPricelistId']) {
    if (input[key] != null && !isId(input[key])) errors.push(`Lista de precios inválida (${key})`);
  }
  if (!String(input.shippingProductSku ?? '').trim()) errors.push('Falta el SKU del producto de envío');
  return errors;
}

// Nombre exacto del payment.method de Odoo ("Medio de pago" del pedido).
export function resolveOdooPaymentName(method, detailId) {
  if (method.details?.length) {
    const detail = method.details.find((d) => d.id === detailId);
    if (!detail) throw new Error(`Elegí el detalle de ${method.label} (cuotas)`);
    return detail.odooName;
  }
  return method.odooName;
}

export const ORIGINS = ['stock', 'exhibicion', 'rolon'];

export function originLocationId(locale, settings, origin) {
  if (origin === 'stock') return locale.stockLocationId;
  if (origin === 'exhibicion') return locale.exhibicionLocationId;
  if (origin === 'rolon') return settings.rolon.locationId;
  throw new Error(`Origen inválido: ${origin}`);
}

export const localeIdsOf = (locales) => locales.map((l) => l.id);

// ---- Firestore con caché corta ----
let cache = { at: 0, locales: null, settings: null, methods: null };
export function clearConfigCache() {
  cache = { at: 0, locales: null, settings: null, methods: null };
}
const fresh = () => Date.now() - cache.at < CACHE_MS;

async function loadAll() {
  if (fresh() && cache.locales) return cache;
  const db = getDb();
  const [locSnap, methodSnap, settingsSnap] = await Promise.all([
    db.collection(LOCALES).get(), db.collection(PAYMENT_METHODS).get(), SETTINGS_REF(db).get(),
  ]);
  cache = {
    at: Date.now(),
    locales: locSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    methods: methodSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)),
    settings: { ...DEFAULT_SETTINGS, ...(settingsSnap.exists ? settingsSnap.data() : {}) },
  };
  return cache;
}

export async function getLocales() {
  return (await loadAll()).locales;
}

export async function getLocale(id) {
  const locale = (await getLocales()).find((l) => l.id === id);
  if (!locale) throw new Error(`Local desconocido: ${id}`);
  return locale;
}

export async function getSettings() {
  return (await loadAll()).settings;
}

export async function getPaymentMethods() {
  return (await loadAll()).methods;
}

export async function getPaymentMethodsById() {
  return new Map((await getPaymentMethods()).map((m) => [m.id, m]));
}

export async function saveLocale(id, input) {
  const errors = validateLocale(input);
  if (errors.length) throw new Error(errors.join('; '));
  const { id: _omit, ...data } = input;
  await getDb().collection(LOCALES).doc(id).set({ ...data, updatedAt: new Date() });
  clearConfigCache();
}

export async function saveSettings(input) {
  const errors = validateSettings(input);
  if (errors.length) throw new Error(errors.join('; '));
  await SETTINGS_REF(getDb()).set({ ...input, updatedAt: new Date() });
  clearConfigCache();
}

export async function savePaymentMethod(id, input) {
  const errors = validatePaymentMethod(input);
  if (errors.length) throw new Error(errors.join('; '));
  const { id: _omit, ...data } = input;
  await getDb().collection(PAYMENT_METHODS).doc(id).set({ ...data, updatedAt: new Date() });
  clearConfigCache();
}

// Carga los valores iniciales solo si la colección está vacía.
export async function seedPosConfigIfNeeded() {
  const db = getDb();
  const [locSnap, methodSnap] = await Promise.all([
    db.collection(LOCALES).limit(1).get(), db.collection(PAYMENT_METHODS).limit(1).get(),
  ]);
  if (locSnap.empty) {
    for (const { id, ...data } of DEFAULT_LOCALES) await db.collection(LOCALES).doc(id).set(data);
    console.log('[pos] locales iniciales cargados');
  }
  if (methodSnap.empty) {
    for (const { id, ...data } of DEFAULT_PAYMENT_METHODS) await db.collection(PAYMENT_METHODS).doc(id).set(data);
    console.log('[pos] medios de pago iniciales cargados');
  }
  clearConfigCache();
}
