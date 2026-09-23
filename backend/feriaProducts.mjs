import { getDb } from './firestore.mjs';
import { withRebaja, activeRebajaField } from './feriaPricing.mjs';

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

// Activa una rebaja y devuelve el producto ya actualizado. El cache se
// actualiza en el acto: onSnapshot llega un instante después, y hasta
// entonces la respuesta (y el buscador) mostraban el precio anterior.
export async function setRebajaActiva(sku, condition, level) {
  const skuId = sku.toUpperCase();
  const ref = getDb().collection(COLLECTION).doc(skuId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error(`SKU no encontrado: ${sku}`);
  const updated = withRebaja({ ...doc.data(), sku: skuId }, condition, level);
  const field = activeRebajaField(condition);
  await ref.update({ [field]: level, updatedAt: new Date() });
  cache.set(skuId, updated);
  return updated;
}
