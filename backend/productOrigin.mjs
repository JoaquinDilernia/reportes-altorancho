// Where each product comes from, per Odoo's product.template:
//   clasificacion_origen (many2many clasificacion.origen): Fábrica /
//     Proveedor Nacional / Importado / Otro (+ rare DUAL, RUSTIC TRAIL)
//   origen (many2many origen.model): country — China, India, Vietnam…
// ~97% of sellable products have it (verified live 2026-11-12). Read straight
// from Odoo with a 6 h cache, so it needs no product re-sync.
import { authenticate, fetchAll } from './odoo.mjs';

const TTL_MS = 6 * 60 * 60 * 1000;
let cache = null;

async function load() {
  await authenticate();
  const [templates, classes, countries] = await Promise.all([
    fetchAll('product.template', [['default_code', '!=', false]], ['default_code', 'clasificacion_origen', 'origen']),
    fetchAll('clasificacion.origen', [], ['id', 'name']),
    fetchAll('origen.model', [], ['id', 'name']),
  ]);
  const className = new Map(classes.map(c => [c.id, c.name]));
  const countryName = new Map(countries.map(c => [c.id, c.name]));
  const bySku = new Map();
  for (const t of templates) {
    bySku.set(t.default_code.trim(), {
      clase: (t.clasificacion_origen || []).map(id => className.get(id)).filter(Boolean)[0] ?? null,
      pais: (t.origen || []).map(id => countryName.get(id)).filter(Boolean)[0] ?? null,
    });
  }
  return bySku;
}

// Never throws: without Odoo the origin section is just empty.
export function getOriginBySku() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = load().catch((err) => {
    console.error('[origin] Odoo error:', err.message);
    cache = null;
    return new Map();
  });
  cache = { at: Date.now(), promise };
  return promise;
}
