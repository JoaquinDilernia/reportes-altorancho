// Costo de cada producto en Odoo (standard_price, sin IVA) + IVA, por SKU.
// Los precios de venta de la tienda y los locales incluyen IVA, así que el
// costo se compara con IVA para que el margen sea consistente.
import { callKwReadWithRetry } from './feriaOdoo.mjs';
import { withIva } from './posPricing.mjs';

const CACHE_MS = 6 * 3600 * 1000;
let cache = null;

export function costMapFromProducts(products) {
  const out = new Map();
  for (const p of products) {
    const sku = (p.default_code || '').trim();
    if (!sku || !(p.standard_price > 0)) continue;
    // Si el SKU se repite (variantes archivadas), gana el costo más alto: no inflar el margen.
    out.set(sku, Math.max(out.get(sku) ?? 0, withIva(p.standard_price)));
  }
  return out;
}

export function getCostBySku() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.promise;
  const promise = callKwReadWithRetry('product.product', 'search_read', [[['default_code', '!=', false]]], {
    fields: ['default_code', 'standard_price'],
    context: { active_test: false },
  }).then(costMapFromProducts);
  cache = { at: Date.now(), promise };
  promise.catch(() => { cache = null; });
  return promise;
}
