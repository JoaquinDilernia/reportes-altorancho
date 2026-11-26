// Precios de los lectores de los locales (ex servicio pick-altorancho):
// copia la lista "Tienda Nube" (+ su "Promo") de Odoo a Firestore `pickalto_products`,
// que es lo que leen las pantallas de pick.pick-altorancho.cloud.
import admin from 'firebase-admin';
import { authenticate, fetchAll } from '../odoo.mjs';
import { getDb } from '../firestore.mjs';

const ODOO_URL = process.env.ODOO_URL || 'https://lett.exemax.ar';
const PRODUCTS_COL = 'pickalto_products';
const METADATA_REF = ['sync_metadata', 'latest'];
const BATCH_SIZE = 500;
const CASH_FACTOR = 0.80; // efectivo: 20% off sobre el precio vigente (promo si hay)

export function formatARS(amount) {
  return '$ ' + Number(amount).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Formato que esperan las pantallas (nombres de campo históricos, typos incluidos)
export function buildProduct(sku, name, templateId, tnPrice, promoPrice) {
  const hasPromo = promoPrice !== null && promoPrice < tnPrice;
  const effectivePrice = hasPromo ? promoPrice : tnPrice;
  const doc = {
    Name: sku,
    Description: name,
    MODELO: name,
    Precio: formatARS(tnPrice),
    Efecivo: formatARS(effectivePrice * CASH_FACTOR),
    Descuento: hasPromo ? 'SI' : 'NO',
  };
  if (hasPromo) {
    doc.Pdesceunto = formatARS(promoPrice);
    doc.Porcentaje = `${Math.round((tnPrice - promoPrice) / tnPrice * 100)}%`;
  }
  if (templateId) doc.img = `${ODOO_URL}/web/image/product.template/${templateId}/image_512`;
  return doc;
}

// La lista "Tienda Nube" y la "Tienda Nube Promo" activas más nuevas
export function pickPricelists(all) {
  const newest = (promo) => all
    .filter((p) => p.name.includes('Tienda Nube') && p.name.toLowerCase().includes('promo') === promo)
    .sort((a, b) => b.id - a.id)[0];
  const tn = newest(false);
  const promo = newest(true);
  if (!tn) throw new Error('No hay lista de precios "Tienda Nube" activa');
  if (!promo) throw new Error('No hay lista de precios "Tienda Nube Promo" activa');
  return { tnId: tn.id, promoId: promo.id };
}

export function buildDocs(tnPrices, promoPrices, productMap) {
  const docs = [];
  let skipped = 0;
  for (const [tmplId, tnPrice] of tnPrices) {
    const p = productMap.get(tmplId);
    if (!p) { skipped++; continue; }
    docs.push({ id: p.sku, data: buildProduct(p.sku, p.name, p.hasImage ? tmplId : null, tnPrice, promoPrices.get(tmplId) ?? null) });
  }
  return { docs, skipped };
}

async function fetchPriceMap(plId) {
  const items = await fetchAll('product.pricelist.item',
    [['pricelist_id', '=', plId], ['compute_price', '=', 'fixed']], ['product_tmpl_id', 'fixed_price'], 1000);
  const map = new Map();
  for (const it of items) if (it.product_tmpl_id) map.set(it.product_tmpl_id[0], it.fixed_price);
  return map;
}

async function fetchProductMap() {
  const base = [['active', '=', true], ['default_code', '!=', false]];
  // Sin el campo imagen (pesado): aparte, solo los ids que tienen imagen
  const [products, withImage] = await Promise.all([
    fetchAll('product.template', base, ['id', 'name', 'default_code'], 1000),
    fetchAll('product.template', [...base, ['image_1920', '!=', false]], ['id'], 1000),
  ]);
  const imageIds = new Set(withImage.map((p) => p.id));
  return new Map(products.map((p) => [p.id, { sku: p.default_code.trim(), name: p.name.trim(), hasImage: imageIds.has(p.id) }]));
}

async function writeDocs(db, docs) {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + BATCH_SIZE)) batch.set(db.collection(PRODUCTS_COL).doc(id), data);
    await batch.commit();
  }
  return docs.length;
}

async function deleteStale(db, activeSkus) {
  const snap = await db.collection(PRODUCTS_COL).select().get();
  const stale = snap.docs.map((d) => d.id).filter((id) => !activeSkus.has(id));
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const id of stale.slice(i, i + BATCH_SIZE)) batch.delete(db.collection(PRODUCTS_COL).doc(id));
    await batch.commit();
  }
  return stale.length;
}

let running = null;
export const isPickSyncRunning = () => running !== null;

export function runPickSync() {
  if (running) {
    const err = new Error('Ya hay una sincronización corriendo');
    err.status = 409;
    return Promise.reject(err);
  }
  running = (async () => {
    const start = Date.now();
    await authenticate();
    const { tnId, promoId } = pickPricelists(await fetchAll('product.pricelist', [['active', '=', true]], ['id', 'name'], 200));
    const [tnPrices, promoPrices, productMap] = await Promise.all([fetchPriceMap(tnId), fetchPriceMap(promoId), fetchProductMap()]);
    const { docs, skipped } = buildDocs(tnPrices, promoPrices, productMap);
    // Lista vacía (p. ej. recién creada en Odoo): abortar antes de tocar Firestore para no borrar todo
    if (docs.length === 0) throw new Error(`Sync abortado: 0 productos en la lista [${tnId}], Firestore no se tocó`);
    const db = getDb();
    const synced = await writeDocs(db, docs);
    const deleted = await deleteStale(db, new Set(docs.map((d) => d.id)));
    const durationMs = Date.now() - start;
    const result = { synced, skipped, deleted, durationMs, pricelists: { tnId, promoId } };
    await db.collection(METADATA_REF[0]).doc(METADATA_REF[1]).set({
      ok: true, synced, skipped, deleted, durationMs, tnPricelist: tnId, promoPricelist: promoId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[pick] precios sincronizados: ${synced} (borrados ${deleted}, sin producto ${skipped}) en ${durationMs}ms`);
    return result;
  })().finally(() => { running = null; });
  return running;
}

export async function getPickSyncStatus() {
  const snap = await getDb().collection(METADATA_REF[0]).doc(METADATA_REF[1]).get();
  return snap.exists ? snap.data() : null;
}
