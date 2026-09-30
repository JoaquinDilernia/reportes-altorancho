// Lista de precios de la feria "en vivo": el Excel vive en Dropbox y el
// negocio lo edita ahí. Cada pocos minutos se baja por su link compartido
// (FERIA_PRICES_URL) y se escriben en feria_products solo los SKUs nuevos o
// que cambiaron. Nunca borra productos ni toca la rebaja activa, y saltea
// las filas incompletas (sin precio): una fila a medio cargar no puede
// terminar vendiéndose a $0. El script scripts/importFeriaPrices.mjs usa el
// mismo parseo para la carga a mano.
import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { getDb } from './firestore.mjs';
import { allFeriaProducts } from './feriaProducts.mjs';

export const SHEET_NAME = 'Precios Feria';
const COLLECTION = 'feria_products';

export const COLUMN_MAP = {
  Modelo: 'modelo',
  Color: 'color',
  Proveedor: 'proveedor',
  Origen: 'origen',
  Stock: 'stock',
  'Costo galpón ($)': 'costoGalpon',
  'Precio Discontinuo': 'precioDiscontinuo',
  'Precio Falla': 'precioFalla',
  'Precio Rebaja 1 Falla': 'precioRebaja1Falla',
  'Precio Rebaja 2 Falla': 'precioRebaja2Falla',
  'Precio Rebaja 1 Discontinuo': 'precioRebaja1Discontinuo',
  'Precio Rebaja 2 Discontinuo': 'precioRebaja2Discontinuo',
};
const NUMERIC_FIELDS = new Set([
  'stock', 'costoGalpon', 'precioDiscontinuo', 'precioFalla',
  'precioRebaja1Falla', 'precioRebaja2Falla',
  'precioRebaja1Discontinuo', 'precioRebaja2Discontinuo',
]);
const FIELDS = Object.values(COLUMN_MAP);

function normalizeRow(row) {
  const doc = {};
  for (const [excelCol, field] of Object.entries(COLUMN_MAP)) {
    const value = row[excelCol];
    doc[field] = NUMERIC_FIELDS.has(field) ? (typeof value === 'number' ? value : null) : (value ?? null);
  }
  return doc;
}

// Una fila vale si tiene precio de Falla y de Discontinuo (> 0).
export function isCompleteRow(doc) {
  return doc.precioFalla > 0 && doc.precioDiscontinuo > 0;
}

// Filas del Excel → productos. Si un SKU se repite, gana la última fila.
export function parsePriceRows(rows) {
  const products = new Map();
  const incomplete = [];
  const duplicates = [];
  rows.forEach((row, i) => {
    if (!row.SKU) return;
    const sku = String(row.SKU).trim().toUpperCase();
    if (!sku) return;
    const doc = normalizeRow(row);
    if (!isCompleteRow(doc)) { incomplete.push(sku); return; }
    if (products.has(sku)) duplicates.push(`${sku} (fila ${i + 2})`);
    products.set(sku, doc);
  });
  return { products, incomplete, duplicates };
}

export function parsePriceWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) throw new Error(`No se encontró la hoja "${SHEET_NAME}" en el Excel`);
  return parsePriceRows(XLSX.utils.sheet_to_json(sheet));
}

const same = (a, b) => (a ?? null) === (b ?? null);

// Qué escribir: productos nuevos (arrancan sin rebaja activa) y los que
// cambiaron en algún campo del Excel. Los que están igual no se tocan.
export function planPriceWrites(products, current) {
  const created = [];
  const updated = [];
  for (const [sku, doc] of products) {
    const existing = current.get(sku);
    if (!existing) created.push({ sku, doc: { ...doc, rebajaFallaActiva: 0, rebajaDiscontinuoActiva: 0 } });
    else if (FIELDS.some((f) => !same(existing[f], doc[f]))) updated.push({ sku, doc });
  }
  return { created, updated };
}

export async function writePricePlan({ created, updated }) {
  const db = getDb();
  const collection = db.collection(COLLECTION);
  const all = [...created, ...updated];
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch();
    for (const { sku, doc } of all.slice(i, i + 400)) {
      batch.set(collection.doc(sku), { ...doc, updatedAt: new Date() }, { merge: true });
    }
    await batch.commit();
  }
}

// Link compartido de Dropbox → descarga directa (dl=1).
export function directDownloadUrl(url) {
  const u = new URL(url);
  if (u.hostname.endsWith('dropbox.com')) {
    u.searchParams.delete('st');
    u.searchParams.set('dl', '1');
  }
  return u.toString();
}

let lastHash = null;
export const priceSyncStatus = { lastRunAt: null, lastChangeAt: null, lastError: null, lastSummary: null };

export async function syncFeriaPricesFromUrl(url) {
  priceSyncStatus.lastRunAt = new Date();
  try {
    const res = await fetch(directDownloadUrl(url), { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`Dropbox respondió ${res.status}`);
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error('El link de Dropbox no devuelve el archivo (¿pide iniciar sesión? tiene que ser "cualquiera con el link")');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    if (hash === lastHash) { priceSyncStatus.lastError = null; return { unchanged: true }; }

    const { products, incomplete, duplicates } = parsePriceWorkbook(buffer);
    const current = new Map(allFeriaProducts().map((p) => [p.sku, p]));
    // Con el cache vacío (Firestore todavía no respondió) todo parecería
    // nuevo y se resetearían las rebajas: mejor esperar a la próxima vuelta.
    if (current.size === 0) throw new Error('El cache de productos todavía no cargó');
    const plan = planPriceWrites(products, current);
    await writePricePlan(plan);
    lastHash = hash;
    const summary = {
      filas: products.size, nuevos: plan.created.length, actualizados: plan.updated.length,
      incompletas: incomplete.length, duplicados: duplicates.length,
      ejemplosIncompletas: incomplete.slice(0, 20),
    };
    priceSyncStatus.lastSummary = summary;
    priceSyncStatus.lastError = null;
    if (plan.created.length || plan.updated.length) {
      priceSyncStatus.lastChangeAt = new Date();
      console.log(`[feriaPriceSync] ${plan.created.length} nuevos, ${plan.updated.length} actualizados`
        + (incomplete.length ? ` · ${incomplete.length} filas incompletas salteadas (${incomplete.slice(0, 10).join(', ')})` : ''));
    }
    return summary;
  } catch (err) {
    priceSyncStatus.lastError = err.message;
    console.error('[feriaPriceSync] error:', err.message);
    return { error: err.message };
  }
}

export function startPriceSync() {
  const url = process.env.FERIA_PRICES_URL;
  if (!url) return;
  const minutes = Number(process.env.FERIA_PRICES_SYNC_MINUTES) || 10;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await syncFeriaPricesFromUrl(url); } finally { running = false; }
  };
  // La primera vuelta espera a que el cache de productos cargue.
  setTimeout(run, 30_000);
  setInterval(run, minutes * 60_000);
  console.log(`[feriaPriceSync] lista de precios desde Dropbox cada ${minutes} min`);
}
