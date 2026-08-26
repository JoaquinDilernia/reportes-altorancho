import { fetchInflationIndex } from '../inflation.mjs';
import { saveInflationIndex, setSyncMetadata } from '../firestore.mjs';

// INDEC publishes monthly and the whole series is only a few hundred KB, so
// (unlike the other syncs) there's no "since last sync" tracking here —
// every run just re-fetches and overwrites the full series. Simpler, and
// correctly picks up INDEC's occasional revisions to recent months.
export async function syncInflation() {
  const rows = await fetchInflationIndex();
  await saveInflationIndex(rows);
  await setSyncMetadata('inflation', { lastSyncedAt: new Date().toISOString(), count: rows.length });

  console.log(`[sync:inflation] ${rows.length} meses sincronizados`);
  return { count: rows.length };
}
