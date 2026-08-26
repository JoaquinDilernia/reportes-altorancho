import 'dotenv/config';
import { syncProducts } from './sync/products.mjs';
import { syncEcommerce } from './sync/ecommerce.mjs';
import { syncLocales } from './sync/locales.mjs';
import { syncMayorista } from './sync/mayorista.mjs';
import { syncFeria } from './sync/feria.mjs';
import { syncMetaAds } from './sync/metaAds.mjs';

function monthsAgoOdoo(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function backfill() {
  // Default covers the full available history: real ecommerce orders in Odoo go
  // back to 2023-03 (~40 months), and a too-short window would leave older docs
  // stuck in a stale/pre-migration shape. Override with --months=N for a shorter run.
  const months = parseInt(process.argv.find(a => a.startsWith('--months='))?.split('=')[1] || '48', 10);
  console.log(`[backfill] starting, ${months} months of history`);

  const { categoryBySku } = await syncProducts();

  const ecommerceResult = await syncEcommerce(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] ecommerce:', ecommerceResult);

  const localesResult = await syncLocales(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] locales:', localesResult);

  const mayoristaResult = await syncMayorista(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] mayorista:', mayoristaResult);

  const feriaResult = await syncFeria(categoryBySku, monthsAgoOdoo(months));
  console.log('[backfill] feria:', feriaResult);

  const metaAdsResult = await syncMetaAds({ daysBack: months * 31, includeAdLevel: false });
  console.log('[backfill] metaAds:', metaAdsResult);

  console.log('[backfill] done');
}

backfill().catch(err => { console.error('[backfill] fatal error:', err); process.exit(1); });
