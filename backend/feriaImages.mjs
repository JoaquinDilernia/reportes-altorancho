// Fotos de los productos de la feria, sacadas de Odoo (image_256 del
// producto: cuadrada, alcanza para tarjetas y listas). Cada consulta a Odoo
// tarda ~1 s, así que se piden de a lotes (al buscar se precargan las de los
// resultados) y se guardan en memoria; el navegador además las cachea.
import { callKwReadWithRetry } from './feriaOdoo.mjs';

const SIGNATURES = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['image/png', (b) => b.subarray(0, 4).toString('hex') === '89504e47'],
  ['image/gif', (b) => b.subarray(0, 3).toString() === 'GIF'],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
];

export function imageContentType(buffer) {
  return SIGNATURES.find(([, matches]) => matches(buffer))?.[0] ?? null;
}

// `fetchImages(skus)` devuelve Map(SKU → Buffer) con los que tienen foto.
// Los que no tienen también se recuerdan (null) para no volver a preguntar.
// `max` limita la memoria: al pasarse se descarta la más vieja.
export function createImageStore(fetchImages, { max = 800 } = {}) {
  const cache = new Map();
  const pending = new Map();

  function remember(sku, image) {
    cache.delete(sku);
    cache.set(sku, image);
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }

  async function prefetch(skus) {
    const wanted = [...new Set(skus.map((s) => s.toUpperCase()))];
    const missing = wanted.filter((sku) => !cache.has(sku) && !pending.has(sku));
    if (missing.length) {
      const batch = fetchImages(missing).then((found) => {
        for (const sku of missing) {
          const data = found.get(sku);
          const contentType = data ? imageContentType(data) : null;
          remember(sku, contentType ? { data, contentType } : null);
        }
      }).finally(() => missing.forEach((sku) => pending.delete(sku)));
      missing.forEach((sku) => pending.set(sku, batch));
    }
    await Promise.all(wanted.map((sku) => pending.get(sku)).filter(Boolean));
  }

  async function get(sku) {
    const key = sku.toUpperCase();
    if (!cache.has(key)) await prefetch([key]);
    return cache.get(key) ?? null;
  }

  return { prefetch, get };
}

// '=ilike': los default_code de Odoo pueden venir en minúsculas o mezclados.
async function fetchOdooImages(skus) {
  const leaves = skus.map((sku) => ['default_code', '=ilike', sku]);
  const domain = [...Array(leaves.length - 1).fill('|'), ...leaves];
  const products = await callKwReadWithRetry('product.product', 'search_read', [domain], {
    fields: ['default_code', 'image_256'],
  });
  const found = new Map();
  for (const p of products) {
    if (p.image_256 && p.default_code) found.set(p.default_code.toUpperCase(), Buffer.from(p.image_256, 'base64'));
  }
  return found;
}

export const productImages = createImageStore(fetchOdooImages);
