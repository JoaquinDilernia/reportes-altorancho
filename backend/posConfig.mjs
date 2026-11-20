// Configuración del POS de locales, editable desde el panel Admin. Los ids
// de Odoo de los valores iniciales se verificaron el 2026-10-13 (ver spec).
import { getDb } from './firestore.mjs';
import { SALDO_METHOD } from './posCredits.mjs';

const LOCALES = 'pos_locales';
const PAYMENT_METHODS = 'pos_payment_methods';
const SETTINGS_REF = (db) => db.collection('pos_settings').doc('general');
const CACHE_MS = 30 * 1000;

// Tipos de remito (spike Fase 2): "Devoluciones" (entrada) y "Transferencias
// internas" de cada almacén. Los destinos de devolución por defecto se arman
// con defaultReturnDestinations si el local no tiene los suyos.
// Diario de venta interna (sin factura) de cada local, verificado el
// 2026-11-17: Ventas Internas San Isidro (VINSI) 85, Belgrano (VINBE) 86,
// Alcorta (VINAL) 87.
export const DEFAULT_LOCALES = [
  { id: 'LL', name: 'Las Lomas', warehouseId: 1, stockLocationId: 8, exhibicionLocationId: 324, teamId: 6, invoiceJournalId: 32, internalInvoiceJournalId: 85, cashJournalId: 54, internalCashJournalId: 33, address: '', active: true, returnPickingTypeId: 6, internalPickingTypeId: 5 },
  { id: 'BL', name: 'Belgrano', warehouseId: 40, stockLocationId: 372, exhibicionLocationId: 379, teamId: 18, invoiceJournalId: 65, internalInvoiceJournalId: 86, cashJournalId: 67, internalCashJournalId: 66, address: '', active: true, returnPickingTypeId: 308, internalPickingTypeId: 307 },
  { id: 'AL', name: 'Alcorta', warehouseId: 41, stockLocationId: 397, exhibicionLocationId: 415, teamId: 25, invoiceJournalId: 78, internalInvoiceJournalId: 87, cashJournalId: 79, internalCashJournalId: 80, address: '', active: true, returnPickingTypeId: 352, internalPickingTypeId: 351 },
];

export const DEFAULT_SETTINGS = {
  rolon: { warehouseId: 28, locationId: 174, outPickingTypeId: 191 },
  web: { locationId: 150 },
  // Devoluciones por falla: Fall/Stock (central, verificada el 2026-11-17).
  fallasLocationId: 192,
  // Transferencia interna EC/Stock → RL/Stock al vender stock web (EC, wh 24).
  webTransferPickingTypeId: 166,
  fullPricelistId: 312,
  orderPricelistId: 314,
  promoPricelistId: 313,
  shippingProductSku: 'ENV002EX',
  decoradorTagId: 1,
  // Lista Decoradora (pedido en Odoo con la lista "[DESC5-DEC] Lista
  // Decoradora", que cambia de id cada mes) y Directorio ("Venta Interna
  // Directorio 2026", al costo; etiqueta de cliente creada el 2026-11-03).
  decoradoraPricelistId: 333,
  decoradoraDiscountPct: 5,
  directorioPricelistId: 255,
  directorioTagId: 33,
  // Venta sin factura fiscal: factura interna que no va a ARCA, en el diario
  // de venta interna del local; si el local no tiene, en este general
  // ("Ventas Internas", VINTE). El cobro va a la Caja Interna del local.
  internalInvoiceJournalId: 28,
  homeServiceSku: 'SERVIDOM',
  homeServiceDefaultAmount: 5000,
  creditValidityDays: null, // null = el saldo a favor no vence
  returnReasons: ['Talle o medida', 'Falla', 'No le gustó', 'Otro'],
  returnSearchDays: 365,
  returnWindowDays: 30, // pasado este plazo la devolución se hace igual pero queda "fuera de plazo"
  creditOdooPaymentName: null, // payment.method de Odoo si se paga todo con saldo
  // Cambios y devoluciones de compras web (ids verificados en Odoo el 2026-11-20):
  // tipo de operación 167, etiqueta 18, depósito EC 24, equipo 1, producto de
  // envío [ENV002EX] = 30306, y ubicaciones Fall/Stock 192, EC/Stock 150,
  // BL/Stock 372, LL/Stock 8, RL/Stock 174.
  webReturns: {
    warehouseId: 24, teamId: 1, tagId: 18,
    returnPickingTypeId: 167,
    shippingProductId: 30306,
    windowBusinessDays: 30,
    holidays: [], // ['2026-12-08', ...]
    destinations: [
      { id: 'fallas', label: 'Fallas', locationId: 192 },
      { id: 'ecommerce', label: 'E Commerce', locationId: 150 },
      { id: 'belgrano', label: 'Belgrano', locationId: 372 },
      { id: 'lomas', label: 'Las Lomas', locationId: 8 },
      { id: 'rolon', label: 'Rolón', locationId: 174 },
    ],
    defaultDestinationByReason: { falla: 'fallas', disconformidad: 'ecommerce' },
  },
};

// Destinos de cambios web que tienen ubicación cargada.
export const webReturnDestinationsOf = (settings) => (settings?.webReturns?.destinations ?? []).filter((d) => isId(d?.locationId));

// Mezcla lo guardado con los valores iniciales; webReturns un nivel más adentro.
export function withSettingsDefaults(stored) {
  const saved = stored ?? {};
  return { ...DEFAULT_SETTINGS, ...saved, webReturns: { ...DEFAULT_SETTINGS.webReturns, ...(saved.webReturns ?? {}) } };
}

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

const DESTINATION_ID = /^[a-z0-9_-]{1,30}$/;

function validateDestinations(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['Destinos de devolución inválidos'];
  const errors = [];
  const seen = new Set();
  for (const d of list) {
    const label = String(d?.label ?? '').trim();
    if (!label) errors.push('Destino de devolución: falta el nombre');
    if (!DESTINATION_ID.test(String(d?.id ?? ''))) errors.push(`Destino de devolución "${label}": código inválido`);
    if (!isId(d?.locationId)) errors.push(`Destino de devolución "${label}": ubicación inválida`);
    if (d?.transferToLocationId != null && !isId(d.transferToLocationId)) errors.push(`Destino de devolución "${label}": depósito de traslado inválido`);
    if (seen.has(d?.id)) errors.push(`Destino de devolución repetido: ${d.id}`);
    seen.add(d?.id);
  }
  const active = list.filter((d) => d?.active !== false);
  if (active.length && active.filter((d) => d.default).length !== 1) errors.push('Tiene que haber un solo destino de devolución por defecto');
  return errors;
}

export function validateLocale(input) {
  const errors = [];
  if (!String(input.name ?? '').trim()) errors.push('Falta el nombre');
  if (!isId(input.warehouseId)) errors.push('Depósito inválido');
  if (!isId(input.stockLocationId)) errors.push('Ubicación de stock inválida');
  if (!isId(input.exhibicionLocationId)) errors.push('Ubicación de exhibición inválida');
  if (!isId(input.teamId)) errors.push('Equipo de ventas inválido');
  if (input.invoiceJournalId != null && !isId(input.invoiceJournalId)) errors.push('Diario de facturas inválido');
  if (input.internalInvoiceJournalId != null && !isId(input.internalInvoiceJournalId)) errors.push('Diario de ventas internas inválido');
  if (input.cashJournalId != null && !isId(input.cashJournalId)) errors.push('Diario de caja inválido');
  if (input.internalCashJournalId != null && !isId(input.internalCashJournalId)) errors.push('Caja interna inválida');
  if (input.returnPickingTypeId != null && !isId(input.returnPickingTypeId)) errors.push('Tipo de remito de devolución inválido');
  if (input.internalPickingTypeId != null && !isId(input.internalPickingTypeId)) errors.push('Tipo de transferencia interna inválido');
  errors.push(...validateDestinations(input.returnDestinations));
  return errors;
}

export function validatePaymentMethod(input) {
  const errors = [];
  if (!String(input.label ?? '').trim()) errors.push('Falta el nombre');
  const pct = input.discountPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) errors.push('El descuento tiene que estar entre 0 y 100');
  if (input.odooJournal != null && input.odooJournal !== 'local' && !isId(input.odooJournal)) errors.push('Diario de cobro inválido');
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
  if (input.fallasLocationId != null && !isId(input.fallasLocationId)) errors.push('Ubicación de fallas inválida');
  if (input.webTransferPickingTypeId != null && !isId(input.webTransferPickingTypeId)) errors.push('Web: tipo de transferencia inválido');
  for (const key of ['fullPricelistId', 'promoPricelistId', 'orderPricelistId', 'decoradoraPricelistId', 'directorioPricelistId']) {
    if (input[key] != null && !isId(input[key])) errors.push(`Lista de precios inválida (${key})`);
  }
  if (input.directorioTagId != null && !isId(input.directorioTagId)) errors.push('Etiqueta de Directorio inválida');
  if (input.internalInvoiceJournalId != null && !isId(input.internalInvoiceJournalId)) errors.push('Diario de ventas internas inválido');
  const decoPct = input.decoradoraDiscountPct;
  if (decoPct != null && !(typeof decoPct === 'number' && decoPct >= 0 && decoPct < 100)) errors.push('Descuento de la lista Decoradora: entre 0 y 99');
  if (!String(input.shippingProductSku ?? '').trim()) errors.push('Falta el SKU del producto de envío');
  if (input.homeServiceSku !== undefined && !String(input.homeServiceSku ?? '').trim()) errors.push('Falta el SKU de la subida al domicilio');
  const homeAmount = input.homeServiceDefaultAmount;
  if (homeAmount !== undefined && (typeof homeAmount !== 'number' || !Number.isFinite(homeAmount) || homeAmount < 0)) {
    errors.push('Monto de subida al domicilio inválido');
  }
  const days = input.creditValidityDays;
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) errors.push('Días de validez del saldo: entre 1 y 3650, o vacío para que no venza');
  if (input.returnReasons !== undefined) {
    const reasons = input.returnReasons;
    if (!Array.isArray(reasons) || !reasons.length) errors.push('Cargá al menos un motivo de devolución');
    else if (reasons.length > 20 || reasons.some((r) => typeof r !== 'string' || !r.trim() || r.length > 60)) errors.push('Motivos de devolución inválidos');
  }
  const windowDays = input.returnWindowDays;
  if (windowDays !== undefined && !(Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 3650)) errors.push('Plazo de devolución: entre 1 y 3650 días');
  const search = input.returnSearchDays;
  if (search !== undefined && !(Number.isInteger(search) && search >= 1 && search <= 1095)) errors.push('Días de búsqueda de compras: entre 1 y 1095');
  const creditName = input.creditOdooPaymentName;
  if (creditName != null && !(typeof creditName === 'string' && creditName.trim())) errors.push('Medio de Odoo para saldo a favor inválido');
  if (input.webReturns !== undefined) validateWebReturns(input.webReturns, errors);
  return errors;
}

function validateWebReturns(w, errors) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) { errors.push('Cambios web: configuración inválida'); return; }
  for (const key of ['warehouseId', 'teamId', 'tagId', 'returnPickingTypeId', 'shippingProductId']) {
    if (w[key] != null && !isId(w[key])) errors.push(`Cambios web: ${key} inválido`);
  }
  if (!(Number.isInteger(w.windowBusinessDays) && w.windowBusinessDays >= 1 && w.windowBusinessDays <= 365)) errors.push('Cambios web: el plazo debe ser de 1 a 365 días hábiles');
  const holidays = w.holidays ?? [];
  const validDate = (h) => typeof h === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h) && new Date(`${h}T00:00:00Z`).toISOString().slice(0, 10) === h;
  if (!Array.isArray(holidays) || holidays.some((h) => !validDate(h))) errors.push('Cambios web: cada feriado debe ser una fecha AAAA-MM-DD válida');
  const dests = w.destinations ?? [];
  if (!Array.isArray(dests)) errors.push('Cambios web: destinos inválidos');
  else {
    const ids = new Set();
    for (const d of dests) {
      if (!d || !String(d.id ?? '').trim() || !String(d.label ?? '').trim()) { errors.push('Cambios web: cada destino necesita código y nombre'); continue; }
      if (ids.has(d.id)) errors.push(`Cambios web: destino repetido (${d.id})`);
      ids.add(d.id);
      if (d.locationId != null && !isId(d.locationId)) errors.push(`Cambios web: ubicación inválida en el destino ${d.id}`);
    }
  }
  const byReason = w.defaultDestinationByReason;
  if (byReason != null && (typeof byReason !== 'object' || Array.isArray(byReason) || Object.values(byReason).some((v) => typeof v !== 'string'))) {
    errors.push('Cambios web: destino por motivo inválido');
  }
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

export const ORIGINS = ['stock', 'exhibicion', 'rolon', 'web'];

export function originLocationId(locale, settings, origin) {
  if (origin === 'stock') return locale.stockLocationId;
  if (origin === 'exhibicion') return locale.exhibicionLocationId;
  if (origin === 'rolon') return settings.rolon.locationId;
  if (origin === 'web') return settings.web.locationId;
  throw new Error(`Origen inválido: ${origin}`);
}

// De dónde sale físicamente en Odoo: lo de web se traslada antes a Rolón.
export const shipLocationId = (locale, settings, origin) => originLocationId(locale, settings, origin === 'web' ? 'rolon' : origin);

export function defaultReturnDestinations(locale, settings) {
  return [
    { id: 'stock', label: 'Stock del local', locationId: locale.stockLocationId, transferToLocationId: null, default: true, active: true },
    { id: 'exhibicion', label: 'Exhibición', locationId: locale.exhibicionLocationId, transferToLocationId: null, default: false, active: true },
    { id: 'rolon', label: 'Enviar a Rolón', locationId: locale.stockLocationId, transferToLocationId: settings.rolon.locationId, default: false, active: true },
    // Igual que Rolón: entra al stock del local y se traslada a Fall/Stock.
    ...(settings.fallasLocationId
      ? [{ id: 'fallas', label: 'Fallas', locationId: locale.stockLocationId, transferToLocationId: settings.fallasLocationId, default: false, active: true }]
      : []),
  ];
}

export function returnDestinationsOf(locale, settings) {
  const own = (locale.returnDestinations ?? []).filter((d) => d.active !== false);
  return own.length ? own : defaultReturnDestinations(locale, settings);
}

export function findDestination(locale, settings, id) {
  const found = returnDestinationsOf(locale, settings).find((d) => d.id === id);
  if (!found) throw new Error('Destino de devolución inválido');
  return found;
}

export const localeIdsOf = (locales) => locales.map((l) => l.id);

// ---- Firestore con caché corta ----
let cache = { at: 0, locales: null, settings: null, methods: null };
export function clearConfigCache() {
  cache = { at: 0, locales: null, settings: null, methods: null };
}
const fresh = () => Date.now() - cache.at < CACHE_MS;

// Locales guardados antes de la Fase 2 no tienen tipos de remito: se completan con los iniciales.
export function withLocaleDefaults(locale) {
  const base = DEFAULT_LOCALES.find((l) => l.id === locale.id) ?? {};
  return {
    ...locale,
    internalInvoiceJournalId: locale.internalInvoiceJournalId !== undefined ? locale.internalInvoiceJournalId : base.internalInvoiceJournalId ?? null,
    returnPickingTypeId: locale.returnPickingTypeId ?? base.returnPickingTypeId ?? null,
    internalPickingTypeId: locale.internalPickingTypeId ?? base.internalPickingTypeId ?? null,
    cashJournalId: locale.cashJournalId ?? base.cashJournalId ?? null,
    internalCashJournalId: locale.internalCashJournalId ?? base.internalCashJournalId ?? null,
  };
}

// Diario de la venta interna: el del local o, si no tiene, el general de Ajustes.
export const internalInvoiceJournalIdOf = (locale, settings) => locale?.internalInvoiceJournalId || settings?.internalInvoiceJournalId || null;

// ¿La factura salió de un diario de venta interna (de algún local o el general)?
export function isInternalJournal(journalId, locales, settings) {
  if (!journalId) return false;
  return journalId === settings?.internalInvoiceJournalId || (locales ?? []).some((l) => l.internalInvoiceJournalId === journalId);
}

// Diario de Odoo donde se registra el cobro de cada medio (la factura queda
// paga). 'local' = la caja del local (cashJournalId). Ids verificados el
// 2026-11-03: Banco Galicia Cta Cte $ 7, Mercado Pago 35, GoCuotas 47.
export const DEFAULT_PAYMENT_JOURNALS = { efectivo: 'local', transferencia: 7, debito: 35, credito: 35, gocuotas: 47 };
const withMethodDefaults = (m) => ({ ...m, odooJournal: m.odooJournal !== undefined ? m.odooJournal : DEFAULT_PAYMENT_JOURNALS[m.id] ?? null });

export function paymentJournalId(method, locale) {
  if (method?.odooJournal === 'local') return locale?.cashJournalId ?? null;
  return isId(method?.odooJournal) ? method.odooJournal : null;
}

async function loadAll() {
  if (fresh() && cache.locales) return cache;
  const db = getDb();
  const [locSnap, methodSnap, settingsSnap] = await Promise.all([
    db.collection(LOCALES).get(), db.collection(PAYMENT_METHODS).get(), SETTINGS_REF(db).get(),
  ]);
  cache = {
    at: Date.now(),
    locales: locSnap.docs.map((d) => withLocaleDefaults({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    methods: methodSnap.docs.map((d) => withMethodDefaults({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)),
    settings: withSettingsDefaults(settingsSnap.exists ? settingsSnap.data() : {}),
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

// "Saldo a favor" es un medio más (0 %, sin medio de Odoo propio): no se
// guarda en pos_payment_methods ni se edita desde Admin.
export async function getPaymentMethodsById() {
  return new Map([...(await getPaymentMethods()).map((m) => [m.id, m]), [SALDO_METHOD.id, SALDO_METHOD]]);
}

export async function saveLocale(id, input) {
  const errors = validateLocale(input);
  if (errors.length) throw new Error(errors.join('; '));
  const { id: _omit, ...data } = input;
  await getDb().collection(LOCALES).doc(id).set({ ...data, updatedAt: new Date() });
  clearConfigCache();
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// El documento se reemplaza entero, pero webReturns nunca se pierde: si no
// viene se conserva lo guardado; si viene parcial se mezcla un nivel sobre lo
// guardado y, en lo que falte, sobre los valores iniciales.
export async function saveSettings(input, db) {
  const partial = input.webReturns;
  const merging = isPlainObject(partial);
  if (!merging) {
    const errors = validateSettings(input);
    if (errors.length) throw new Error(errors.join('; '));
  }
  const ref = SETTINGS_REF(db ?? getDb());
  const snap = await ref.get();
  const stored = snap.exists ? snap.data() ?? {} : {};
  let data = { ...input };
  if (merging) {
    data = { ...input, webReturns: { ...DEFAULT_SETTINGS.webReturns, ...(isPlainObject(stored.webReturns) ? stored.webReturns : {}), ...partial } };
    const errors = validateSettings(data);
    if (errors.length) throw new Error(errors.join('; '));
  } else if (partial === undefined && stored.webReturns !== undefined) {
    data.webReturns = stored.webReturns;
  }
  await ref.set({ ...data, updatedAt: new Date() });
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
