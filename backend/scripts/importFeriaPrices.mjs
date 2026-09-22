import 'dotenv/config';
import XLSX from 'xlsx';
import { getDb } from '../firestore.mjs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Uso: node scripts/importFeriaPrices.mjs <ruta-al-excel>');
  process.exit(1);
}

const COLUMN_MAP = {
  SKU: 'sku',
  Modelo: 'modelo',
  Color: 'color',
  Proveedor: 'proveedor',
  Origen: 'origen',
  Stock: 'stock',
  'Precio Discontinuo': 'precioDiscontinuo',
  'Precio Falla': 'precioFalla',
  'Precio Rebaja 1 Falla': 'precioRebaja1Falla',
  'Precio Rebaja 2 Falla': 'precioRebaja2Falla',
  'Precio Rebaja 1 Discontinuo': 'precioRebaja1Discontinuo',
  'Precio Rebaja 2 Discontinuo': 'precioRebaja2Discontinuo',
};
const NUMERIC_FIELDS = new Set([
  'stock', 'precioDiscontinuo', 'precioFalla',
  'precioRebaja1Falla', 'precioRebaja2Falla',
  'precioRebaja1Discontinuo', 'precioRebaja2Discontinuo',
]);

function normalizeRow(row) {
  const doc = {};
  for (const [excelCol, field] of Object.entries(COLUMN_MAP)) {
    if (field === 'sku') continue;
    const value = row[excelCol];
    doc[field] = NUMERIC_FIELDS.has(field) ? (typeof value === 'number' ? value : null) : (value ?? null);
  }
  return doc;
}

async function main() {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets['Precios Feria'];
  if (!sheet) throw new Error('No se encontró la hoja "Precios Feria" en el excel');
  const rows = XLSX.utils.sheet_to_json(sheet);

  const db = getDb();
  const collection = db.collection('feria_products');
  const existingSnap = await collection.get();
  const existingSkus = new Set(existingSnap.docs.map((d) => d.id));

  let batch = db.batch();
  let opsInBatch = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.SKU) { skipped++; continue; }
    const sku = String(row.SKU).trim().toUpperCase();
    const payload = { ...normalizeRow(row), updatedAt: new Date() };
    if (!existingSkus.has(sku)) {
      // Docs nuevos arrancan sin rebaja activa. Docs existentes NO tocan
      // estos dos campos acá (merge:true solo escribe lo que mandamos) —
      // así un re-import con precios actualizados no resetea una rebaja
      // que el admin ya activó a mano durante el evento.
      payload.rebajaFallaActiva = 0;
      payload.rebajaDiscontinuoActiva = 0;
      created++;
    } else {
      updated++;
    }
    batch.set(collection.doc(sku), payload, { merge: true });
    opsInBatch++;
    if (opsInBatch === 400) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) await batch.commit();

  console.log(`[importFeriaPrices] Listo. Creados: ${created}, actualizados: ${updated}, filas sin SKU: ${skipped}, total filas: ${rows.length}`);
}

main().catch((err) => {
  console.error('[importFeriaPrices] Error:', err.message);
  process.exit(1);
});
