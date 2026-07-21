import { fetchAllProducts } from '../tiendanube.mjs';
import { authenticate, fetchAll } from '../odoo.mjs';
import { primaryTiendanubeCategory, leafOdooCategoryName } from '../categories.mjs';
import { extractSkuFromDisplayName } from '../normalize.mjs';
import { saveProducts } from '../firestore.mjs';

// Odoo stock.location ids for the warehouses we care about (verified live
// against stock.warehouse — the other warehouses in this Odoo instance
// belong to unrelated stores/brands sharing the same ERP).
const LOCATION_CHANNELS = {
  8: 'local_lomas',      // LL/Stock
  372: 'local_belgrano',  // BL/Stock
  397: 'local_alcorta',   // AL/Stock
  168: 'mayorista',       // MAY/Stock
  150: 'ecommerce_odoo',  // EC/Stock — Odoo's own web warehouse, which can
                           // legitimately diverge from Tiendanube's own
                           // reported stock (that's the whole point of
                           // surfacing it separately).
  174: 'deposito',        // RL/Stock — Rolón Local, the central warehouse.
};

async function fetchStockByLocation() {
  const quants = await fetchAll(
    'stock.quant',
    [['location_id', 'in', Object.keys(LOCATION_CHANNELS).map(Number)], ['quantity', '>', 0]],
    ['product_id', 'location_id', 'quantity'],
  );

  const bySku = new Map();
  for (const q of quants) {
    const sku = extractSkuFromDisplayName(q.product_id[1]);
    const channel = LOCATION_CHANNELS[q.location_id[0]];
    if (!bySku.has(sku)) bySku.set(sku, {});
    const entry = bySku.get(sku);
    entry[channel] = (entry[channel] || 0) + q.quantity;
  }
  return bySku;
}

export async function syncProducts() {
  const categoryBySku = new Map();
  const productDocs = [];

  const tnProducts = await fetchAllProducts();
  for (const product of tnProducts) {
    const category = primaryTiendanubeCategory(product.categories);
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      categoryBySku.set(variant.sku, category);
      productDocs.push({
        sku: variant.sku,
        name: product.name?.es || '',
        category,
        currentStock: variant.stock ?? 0,
      });
    }
  }

  await authenticate();
  const odooProducts = await fetchAll(
    'product.template',
    [['default_code', '!=', false]],
    ['default_code', 'name', 'categ_id'],
  );

  const knownSkus = new Set(productDocs.map(d => d.sku));
  for (const p of odooProducts) {
    const sku = p.default_code.trim();
    if (knownSkus.has(sku)) continue; // ya cargado desde Tienda Nube, con su stock real
    const category = leafOdooCategoryName(p.categ_id?.[1]);
    categoryBySku.set(sku, category);
    productDocs.push({ sku, name: p.name.trim(), category, currentStock: null });
  }

  const stockByLocationBySku = await fetchStockByLocation();
  for (const doc of productDocs) {
    doc.stockByLocation = stockByLocationBySku.get(doc.sku) || null;
  }

  console.log(`[sync:products] ${productDocs.length} productos (${knownSkus.size} desde Tienda Nube)`);
  await saveProducts(productDocs);
  return { categoryBySku, count: productDocs.length };
}
