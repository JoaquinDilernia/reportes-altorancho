import { fetchOrdersSince } from '../tiendanube.mjs';
import { normalizeTiendanubeOrder } from '../normalize.mjs';
import { saveSalesDocs, getSyncMetadata, setSyncMetadata } from '../firestore.mjs';

export async function syncEcommerce(categoryBySku, sinceOverride) {
  const meta = await getSyncMetadata('ecommerce');
  const since = sinceOverride || meta?.lastSyncedAt || null;

  const orders = await fetchOrdersSince(since);
  const docs = orders.map(order => normalizeTiendanubeOrder(order, categoryBySku));

  await saveSalesDocs(docs);
  await setSyncMetadata('ecommerce', { lastSyncedAt: new Date().toISOString(), count: docs.length });

  console.log(`[sync:ecommerce] ${docs.length} órdenes sincronizadas (desde ${since || 'el origen'})`);
  return { count: docs.length };
}
