import 'dotenv/config';
import fs from 'node:fs';
import { getDb } from '../firestore.mjs';
import { parsePriceWorkbook, planPriceWrites, writePricePlan } from '../feriaPriceSync.mjs';

// Carga a mano de la lista de precios (la misma lógica que la sincronización
// en vivo desde Dropbox, feriaPriceSync.mjs): escribe solo lo nuevo o lo que
// cambió, saltea filas sin precio y no toca las rebajas activas.
const filePath = process.argv[2];
if (!filePath) {
  console.error('Uso: node scripts/importFeriaPrices.mjs <ruta-al-excel>');
  process.exit(1);
}

async function main() {
  const { products, incomplete, duplicates } = parsePriceWorkbook(fs.readFileSync(filePath));
  const snap = await getDb().collection('feria_products').get();
  const current = new Map(snap.docs.map((d) => [d.id, d.data()]));
  const plan = planPriceWrites(products, current);
  await writePricePlan(plan);
  for (const d of duplicates) console.warn(`[importFeriaPrices] SKU duplicado en el excel, gana la última fila: ${d}`);
  if (incomplete.length) console.warn(`[importFeriaPrices] Filas sin precio salteadas (${incomplete.length}): ${incomplete.join(', ')}`);
  console.log(`[importFeriaPrices] Listo. Nuevos: ${plan.created.length}, actualizados: ${plan.updated.length}, sin cambios: ${products.size - plan.created.length - plan.updated.length}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[importFeriaPrices] Error:', err.message);
  process.exit(1);
});
