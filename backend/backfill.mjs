import 'dotenv/config';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';

function monthsAgoOdoo(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function backfill() {
  const months = parseInt(process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || '14', 10);
  console.log(`[backfill] starting, ${months} months of history`);

  const { categoryBySku } = await syncProducts();

  const ecommerceResult = await syncEcommerce(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] ecommerce:', ecommerceResult);

  const localesResult = await syncLocales(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] locales:', localesResult);

  const mayoristaResult = await syncMayorista(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] mayorista:', mayoristaResult);

  console.log('[backfill] done');
}

backfill().catch(err => { console.error('[backfill] fatal error:', err); process.exit(1); });
