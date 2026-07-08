import { fetchAllProducts } from '../tiendanube.mjs';
import { authenticate, fetchAll } from '../odoo.mjs';
import { primaryTiendanubeCategory, leafOdooCategoryName } from '../categories.mjs';
import { saveProducts } from '../firestore.mjs';

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

  console.log(`[sync:products] ${productDocs.length} productos (${knownSkus.size} desde Tienda Nube)`);
  await saveProducts(productDocs);
  return { categoryBySku, count: productDocs.length };
}
