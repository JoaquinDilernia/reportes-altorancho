// Productos, precios y stock del POS, leídos de Odoo en vivo (con caché
// corta). Los precios salen de las listas Tienda Nube (full y promo), que ya
// incluyen IVA; list_price del producto nunca se usa. Stock "libre" = cantidad
// − reservado en Odoo; las reservas de la app se descuentan en groupStock.
import { callKwReadWithRetry } from './feriaOdoo.mjs';
import { round2, basePriceOf } from './posPricing.mjs';

const WEB_UNLIMITED_FROM = 100000;
const CACHE_MS = 60 * 1000;
const PRODUCT_FIELDS = ['id', 'name', 'default_code', 'product_tmpl_id'];

// Precio (con IVA, tal cual está en la lista) según los ítems de una lista: el
// de la variante gana sobre el de la plantilla. Solo precio fijo; un % no tiene
// base confiable → null.
export function priceFromItems(product, items) {
  const tmplId = product.product_tmpl_id?.[0];
  const forVariant = items.find((i) => i.applied_on === '0_product_variant' && i.product_id?.[0] === product.id);
  const forTemplate = items.find((i) => i.applied_on === '1_product' && i.product_tmpl_id?.[0] === tmplId);
  const item = forVariant ?? forTemplate;
  if (!item) return null;
  if (item.compute_price === 'fixed') return item.fixed_price;
  return null;
}

// Sin precio full → null (no vendible, se excluye).
export function buildCatalogProduct(raw, fullItems, promoItems) {
  const full = priceFromItems(raw, fullItems);
  if (full == null) return null;
  const promo = priceFromItems(raw, promoItems);
  const fullPrice = round2(full);
  const promoPrice = promo == null ? null : round2(promo);
  return {
    productId: raw.id, templateId: raw.product_tmpl_id[0], sku: raw.default_code ?? '', name: raw.name,
    fullPrice, promoPrice, basePrice: basePriceOf({ fullPrice, promoPrice }),
  };
}

export function freeByLocation(quants) {
  const result = new Map();
  for (const q of quants) {
    const productId = q.product_id[0];
    const locationId = q.location_id[0];
    if (!result.has(productId)) result.set(productId, new Map());
    const byLoc = result.get(productId);
    byLoc.set(locationId, (byLoc.get(locationId) ?? 0) + q.quantity - (q.reserved_quantity ?? 0));
  }
  return result;
}

export function groupStock({ freeByLoc, appReserved, locales, settings, localId }) {
  const free = (locationId) => Math.max(0, (freeByLoc.get(locationId) ?? 0) - (appReserved.get(locationId) ?? 0));
  const own = locales.find((l) => l.id === localId);
  const webRaw = freeByLoc.get(settings.web.locationId) ?? 0;
  return {
    local: own ? { stock: free(own.stockLocationId), exhibicion: free(own.exhibicionLocationId) } : null,
    rolon: free(settings.rolon.locationId),
    web: webRaw >= WEB_UNLIMITED_FROM ? { qty: null, unlimited: true } : { qty: Math.max(0, webRaw), unlimited: false },
    otros: locales
      .filter((l) => l.id !== localId)
      .map((l) => ({ localId: l.id, name: l.name, qty: free(l.stockLocationId) + free(l.exhibicionLocationId) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es')),
  };
}

export function stockLocationIds(locales, settings) {
  return [
    ...locales.flatMap((l) => [l.stockLocationId, l.exhibicionLocationId]),
    settings.rolon.locationId, settings.web.locationId,
  ];
}

async function pricelistItems(pricelistId, products) {
  if (!pricelistId || !products.length) return [];
  return callKwReadWithRetry('product.pricelist.item', 'search_read', [[
    ['pricelist_id', '=', pricelistId],
    '|', ['product_id', 'in', products.map((p) => p.id)], ['product_tmpl_id', 'in', products.map((p) => p.product_tmpl_id[0])],
  ]], { fields: ['applied_on', 'product_id', 'product_tmpl_id', 'compute_price', 'fixed_price', 'percent_price', 'date_start', 'date_end'] });
}

// Ítems vigentes hoy (date_start/date_end de Odoo: 'YYYY-MM-DD HH:mm:ss' UTC).
function currentItems(items, now = Date.now()) {
  const toMs = (s) => new Date(`${s.replace(' ', 'T')}Z`).getTime();
  return items.filter((i) => (!i.date_start || toMs(i.date_start) <= now) && (!i.date_end || toMs(i.date_end) >= now));
}

async function toCatalogProducts(rawProducts, settings) {
  if (!settings.fullPricelistId) throw new Error('Configurá la lista de precios full en Admin → Ajustes');
  const [fullItems, promoItems] = await Promise.all([
    pricelistItems(settings.fullPricelistId, rawProducts), pricelistItems(settings.promoPricelistId, rawProducts),
  ]);
  const full = currentItems(fullItems);
  const promo = currentItems(promoItems);
  return rawProducts.map((p) => buildCatalogProduct(p, full, promo)).filter(Boolean);
}

const searchCache = new Map();

export async function searchCatalog(query, settings) {
  const q = String(query ?? '').trim();
  const key = `${settings.fullPricelistId}|${settings.promoPricelistId}|${q.toUpperCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.products;
  const raw = await callKwReadWithRetry('product.product', 'search_read', [[
    ['sale_ok', '=', true], ['default_code', '!=', false],
    '|', ['default_code', 'ilike', q], ['name', 'ilike', q],
  ]], { fields: PRODUCT_FIELDS, limit: 30, order: 'default_code' });
  const products = await toCatalogProducts(raw, settings);
  searchCache.set(key, { at: Date.now(), products });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return products;
}

export async function getCatalogProducts(productIds, settings) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();
  const raw = await callKwReadWithRetry('product.product', 'read', [ids], { fields: PRODUCT_FIELDS });
  const products = await toCatalogProducts(raw, settings);
  return new Map(products.map((p) => [p.productId, p]));
}

export async function fetchFreeStock(productIds, locationIds) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();
  const quants = await callKwReadWithRetry('stock.quant', 'search_read', [[
    ['product_id', 'in', ids], ['location_id', 'in', locationIds],
  ]], { fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'] });
  return freeByLocation(quants);
}
