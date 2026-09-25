import { getDb } from './firestore.mjs';
import { rebajaUpdate } from './feriaPricing.mjs';

const COLLECTION = 'feria_products';
let cache = new Map();
let unsubscribe = null;

// Mantiene un cache en memoria de todo `feria_products`, actualizado en
// tiempo real vía onSnapshot — así el admin puede activar una rebaja desde
// el panel Caja y el buscador del panel Vendedor/público la refleja al
// toque, sin tener que reiniciar el servidor ni pegarle a Firestore en cada
// búsqueda (el catálogo tiene ~3000 SKUs, cabe cómodo en memoria).
export function startFeriaProductsCache() {
  if (unsubscribe) return;
  const db = getDb();
  unsubscribe = db.collection(COLLECTION).onSnapshot(
    (snap) => {
      const next = new Map();
      snap.forEach((doc) => next.set(doc.id, { sku: doc.id, ...doc.data() }));
      cache = next;
      console.log(`[feriaProducts] Cache actualizado: ${cache.size} SKUs`);
    },
    (err) => console.error('[feriaProducts] Error escuchando feria_products:', err.message)
  );
}

export function searchFeriaProducts(query) {
  const q = (query ?? '').trim().toUpperCase();
  if (q.length < 3) return [];
  const results = [];
  for (const product of cache.values()) {
    const matches = product.sku.toUpperCase().includes(q) || (product.modelo ?? '').toUpperCase().includes(q);
    if (!matches) continue;
    results.push(product);
    if (results.length >= 30) break;
  }
  return results;
}

export function getFeriaProduct(sku) {
  return cache.get((sku ?? '').toUpperCase()) ?? null;
}

// Activa una rebaja (la 3 con su precio manual) y devuelve el producto ya
// actualizado. El cache se actualiza en el acto: onSnapshot llega un
// instante después, y hasta entonces la respuesta (y el buscador) mostraban
// el precio anterior.
export async function setRebajaActiva(sku, condition, level, manualPrice) {
  const skuId = sku.toUpperCase();
  const ref = getDb().collection(COLLECTION).doc(skuId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error(`SKU no encontrado: ${sku}`);
  const product = { ...doc.data(), sku: skuId };
  const update = rebajaUpdate(product, condition, level, manualPrice);
  await ref.update({ ...update, updatedAt: new Date() });
  const updated = { ...product, ...update };
  cache.set(skuId, updated);
  return updated;
}

// Productos con una rebaja activa (1, 2 o 3) en alguna condición que tenga
// precio, para revisar desde Caja qué está rebajado. `counts` trae cuántos
// hay en cada nivel; sin `level`, solo los contadores.
export function filterByRebaja(products, level) {
  const REBAJA_FILTER_LEVELS = [1, 2, 3];
  const levelsOf = (p) => new Set([
    p.precioFalla != null ? p.rebajaFallaActiva ?? 0 : 0,
    p.precioDiscontinuo != null ? p.rebajaDiscontinuoActiva ?? 0 : 0,
  ]);
  const counts = Object.fromEntries(REBAJA_FILTER_LEVELS.map((l) => [l, 0]));
  const matching = [];
  for (const p of products) {
    const levels = levelsOf(p);
    for (const l of REBAJA_FILTER_LEVELS) if (levels.has(l)) counts[l] += 1;
    if (level != null && levels.has(level)) matching.push(p);
  }
  matching.sort((a, b) => (a.modelo ?? '').localeCompare(b.modelo ?? '', 'es'));
  return { counts, products: matching };
}

export function filterCachedByRebaja(level) {
  return filterByRebaja(cache.values(), level);
}

export function allFeriaProducts() {
  return [...cache.values()];
}
