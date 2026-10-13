// Reservas de la app (pos_reservations/{productId}__{locationId}). El
// disponible real es el libre de Odoo menos lo reservado acá. Leer y escribir
// siempre dentro de la misma transacción: dos vendedores no se pisan.
import { parseReservationKey, reservationKey } from './posLines.mjs';

export const RESERVATIONS_COLLECTION = 'pos_reservations';

export async function readReservations(db, keys, tx = null) {
  const result = new Map();
  if (!keys.length) return result;
  const refs = keys.map((key) => db.collection(RESERVATIONS_COLLECTION).doc(key));
  const snaps = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
  snaps.forEach((snap, i) => result.set(keys[i], snap.exists ? (snap.data().reserved ?? 0) : 0));
  return result;
}

export function checkAvailability(freeStock, reserved, deltas, skuById) {
  const errors = [];
  for (const [key, delta] of deltas) {
    if (delta <= 0) continue;
    const { productId, locationId } = parseReservationKey(key);
    const free = freeStock.get(productId)?.get(locationId) ?? 0;
    const available = Math.max(0, free - (reserved.get(key) ?? 0));
    if (delta > available) errors.push(`${skuById.get(productId) ?? productId}: pediste ${delta} y quedan ${available} en esa ubicación`);
  }
  return errors;
}

export function writeReservations(tx, db, reserved, deltas) {
  for (const [key, delta] of deltas) {
    const { productId, locationId } = parseReservationKey(key);
    const value = Math.max(0, (reserved.get(key) ?? 0) + delta);
    tx.set(db.collection(RESERVATIONS_COLLECTION).doc(key), { productId, locationId, reserved: value, updatedAt: new Date() });
  }
}

export function appReservedFor(reserved, productId) {
  const result = new Map();
  for (const [key, value] of reserved) {
    const parsed = parseReservationKey(key);
    if (parsed.productId === productId && value) result.set(parsed.locationId, value);
  }
  return result;
}

export function readReservationsFor(db, productIds, locationIds) {
  const keys = productIds.flatMap((p) => locationIds.map((l) => reservationKey(p, l)));
  return readReservations(db, keys);
}
