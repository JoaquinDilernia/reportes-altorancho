import { callKwReadWithRetry } from './feriaOdoo.mjs';
import { getDb } from './firestore.mjs';
import { extractSkuFromDisplayName } from './normalize.mjs';
import { reservationKey, parseReservationKey, LOCATIONS, LOCATION_LABELS } from './feriaLines.mjs';

export const RESERVATIONS_COLLECTION = 'feria_reservations';

// Ids de FER/Stock/exhibicion y FER/Stock/Rolon. Por variable de entorno y no
// hardcodeados: si alguien recrea las ubicaciones en Odoo, se cambia el env.
export function feriaLocationIds() {
  const exhibicion = Number(process.env.ODOO_FERIA_LOCATION_EXHIBICION_ID);
  const rolon = Number(process.env.ODOO_FERIA_LOCATION_ROLON_ID);
  if (!exhibicion || !rolon) throw new Error('Faltan ODOO_FERIA_LOCATION_EXHIBICION_ID / ODOO_FERIA_LOCATION_ROLON_ID');
  return { exhibicion, rolon };
}

// '=ilike' y no 'in': los default_code de Odoo pueden estar en minúsculas o
// mezclados y los SKU de la app están en mayúsculas.
export function skuDomain(skus) {
  const leaves = skus.map((sku) => ['product_id.default_code', '=ilike', sku]);
  return [...Array(Math.max(leaves.length - 1, 0)).fill('|'), ...leaves];
}

export function sumQuantsBySku(quants, locationIds) {
  const byLocationId = Object.fromEntries(Object.entries(locationIds).map(([name, id]) => [id, name]));
  const result = new Map();
  for (const q of quants) {
    const location = byLocationId[q.location_id[0]];
    if (!location) continue;
    const sku = extractSkuFromDisplayName(q.product_id[1]).toUpperCase();
    if (!result.has(sku)) result.set(sku, { exhibicion: 0, rolon: 0 });
    result.get(sku)[location] += q.quantity;
  }
  return result;
}

// Stock físico en Odoo por ubicación de la feria, consultado en vivo (una
// sola llamada para todos los SKUs).
export async function fetchOdooStock(skus) {
  const unique = [...new Set(skus.map((s) => s.toUpperCase()))];
  if (!unique.length) return new Map();
  const locationIds = feriaLocationIds();
  const quants = await callKwReadWithRetry('stock.quant', 'search_read', [
    [['location_id', 'in', Object.values(locationIds)], ...skuDomain(unique)],
  ], { fields: ['product_id', 'location_id', 'quantity'] });
  return sumQuantsBySku(quants, locationIds);
}

// Lee los contadores de reserva. Con `tx` lo hace dentro de la transacción
// (obligatorio antes de escribirlos: así dos vendedores no se pisan).
export async function readReservations(db, keys, tx = null) {
  const result = new Map();
  if (!keys.length) return result;
  const refs = keys.map((key) => db.collection(RESERVATIONS_COLLECTION).doc(key));
  const snaps = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
  snaps.forEach((snap, i) => result.set(keys[i], snap.exists ? (snap.data().reserved ?? 0) : 0));
  return result;
}

export function availabilityFor(odooStock, reserved, sku) {
  const upper = sku.toUpperCase();
  const odoo = odooStock.get(upper) ?? { exhibicion: 0, rolon: 0 };
  const out = {};
  for (const location of LOCATIONS) {
    out[location] = Math.max(0, (odoo[location] ?? 0) - (reserved.get(reservationKey(upper, location)) ?? 0));
  }
  return out;
}

export async function getAvailability(db, skus) {
  const odooStock = await fetchOdooStock(skus);
  const keys = [...new Set(skus.flatMap((sku) => LOCATIONS.map((loc) => reservationKey(sku, loc))))];
  const reserved = await readReservations(db, keys);
  return new Map(skus.map((sku) => [sku.toUpperCase(), availabilityFor(odooStock, reserved, sku)]));
}

export { getDb };

// Verifica que las reservas nuevas (deltas > 0) entren en el disponible.
// Liberar (deltas ≤ 0) nunca se bloquea.
export function checkAvailability(odooStock, reserved, deltas) {
  const errors = [];
  for (const [key, delta] of deltas) {
    if (delta <= 0) continue;
    const { sku, location } = parseReservationKey(key);
    const available = availabilityFor(odooStock, reserved, sku)[location];
    if (delta > available) errors.push(`${sku} en ${LOCATION_LABELS[location]}: pediste ${delta}, hay ${available}`);
  }
  return errors;
}

export function nextReserved(reserved, deltas) {
  const next = new Map();
  for (const [key, delta] of deltas) next.set(key, Math.max(0, (reserved.get(key) ?? 0) + delta));
  return next;
}

export function writeReservations(tx, db, reserved, deltas) {
  for (const [key, value] of nextReserved(reserved, deltas)) {
    const { sku, location } = parseReservationKey(key);
    tx.set(db.collection(RESERVATIONS_COLLECTION).doc(key), { sku, location, reserved: value, updatedAt: new Date() });
  }
}
