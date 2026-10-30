import 'dotenv/config';
import admin from 'firebase-admin';
import { parseSourceDate } from './normalize.mjs';

let db;

export function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
    db = admin.firestore();
  }
  return db;
}

const SALES_COL    = 'altorancho_reportes_sales';
const PRODUCTS_COL = 'altorancho_reportes_products';
const METADATA_COL = 'altorancho_reportes_sync_metadata';
const BATCH_SIZE   = 500;
const META_ADS_DAILY_COL = 'altorancho_reportes_meta_ads_daily';
const META_ADS_AD_DAILY_COL = 'altorancho_reportes_meta_ads_ad_daily';
const INFLATION_INDEX_COL = 'altorancho_reportes_inflation_index';
const GOOGLE_ADS_DAILY_COL = 'altorancho_reportes_google_ads_daily';

// Cache en memoria de lecturas. Cada reporte leía la colección de productos
// entera (~7.800 docs) y los rangos de ventas/ads completos, y era el grueso
// de la factura de Firestore. Todos los datos cambian solo vía los save*
// de este archivo (los syncs corren en este mismo proceso), que vacían el
// cache de su colección; el TTL cubre escrituras de otros procesos
// (backfill, scripts). Se cachea la promesa para que pedidos simultáneos
// compartan una sola lectura.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const caches = new Map();

// `fresh` saltea el cache: lo usa el reporte en vivo del evento (Cyber), que
// tiene que reflejar cada sync apenas termina.
function cached(col, key, load, { fresh = false } = {}) {
  if (fresh) return load();
  if (!caches.has(col)) caches.set(col, new Map());
  const cache = caches.get(col);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = load().catch((err) => { cache.delete(key); throw err; });
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

function invalidate(col) { caches.delete(col); }

export function clearReadCache() { caches.clear(); }

export async function saveSalesDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(SALES_COL).doc(doc.id), {
        ...doc,
        date: admin.firestore.Timestamp.fromDate(parseSourceDate(doc.date)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  invalidate(SALES_COL);
  return { written: docs.length };
}

export function querySalesByRange(channels, startDate, endDate, opts) {
  const key = `${[...channels].sort().join(',')}|${startDate}|${endDate}`;
  return cached(SALES_COL, key, () => fetchSalesByRange(channels, startDate, endDate), opts);
}

async function fetchSalesByRange(channels, startDate, endDate) {
  const firestore = getDb();
  // Argentina is UTC-3, no DST: local midnight for a calendar date is
  // UTC 03:00 of that same date, and the day ends at UTC 03:00 of the
  // next date, minus 1ms.
  const start = admin.firestore.Timestamp.fromDate(new Date(`${startDate}T03:00:00.000Z`));
  const end = admin.firestore.Timestamp.fromDate(new Date(new Date(`${endDate}T03:00:00.000Z`).getTime() + 24 * 3600 * 1000 - 1));

  const snap = await firestore.collection(SALES_COL)
    .where('channel', 'in', channels)
    .where('date', '>=', start)
    .where('date', '<=', end)
    .get();

  return snap.docs.map(d => {
    const data = d.data();
    return { ...data, date: data.date.toDate().toISOString() };
  });
}

export async function saveProducts(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(PRODUCTS_COL).doc(encodeURIComponent(doc.sku)), doc);
    }
    await batch.commit();
  }
  invalidate(PRODUCTS_COL);
  return { written: docs.length };
}

export async function getProductBySku(sku) {
  const firestore = getDb();
  const snap = await firestore.collection(PRODUCTS_COL).doc(encodeURIComponent(sku)).get();
  return snap.exists ? snap.data() : null;
}

export function getProductsBySku() {
  return cached(PRODUCTS_COL, 'all', async () => {
    const firestore = getDb();
    const snap = await firestore.collection(PRODUCTS_COL).get();
    const map = new Map();
    for (const doc of snap.docs) {
      const data = doc.data();
      map.set(data.sku, data);
    }
    return map;
  });
}

export async function getSyncMetadata(channel) {
  const firestore = getDb();
  const snap = await firestore.collection(METADATA_COL).doc(channel).get();
  return snap.exists ? snap.data() : null;
}

export async function setSyncMetadata(channel, data) {
  const firestore = getDb();
  await firestore.collection(METADATA_COL).doc(channel).set({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function saveMetaAdsDailyDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(META_ADS_DAILY_COL).doc(doc.date), {
        ...doc,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  invalidate(META_ADS_DAILY_COL);
  return { written: docs.length };
}

export async function saveMetaAdsAdDailyDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(META_ADS_AD_DAILY_COL).doc(`${doc.adId}_${doc.date}`), {
        ...doc,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  invalidate(META_ADS_AD_DAILY_COL);
  return { written: docs.length };
}

function queryDateRange(col, startDate, endDate, opts) {
  return cached(col, `${startDate}|${endDate}`, async () => {
    const firestore = getDb();
    const snap = await firestore.collection(col)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();
    return snap.docs.map(d => d.data());
  }, opts);
}

export function queryMetaAdsDailyByRange(startDate, endDate, opts) {
  return queryDateRange(META_ADS_DAILY_COL, startDate, endDate, opts);
}

export function queryMetaAdsAdDailyByRange(startDate, endDate, opts) {
  return queryDateRange(META_ADS_AD_DAILY_COL, startDate, endDate, opts);
}

export async function saveGoogleAdsDailyDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(GOOGLE_ADS_DAILY_COL).doc(doc.date), {
        ...doc,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  invalidate(GOOGLE_ADS_DAILY_COL);
  return { written: docs.length };
}

export function queryGoogleAdsDailyByRange(startDate, endDate, opts) {
  return queryDateRange(GOOGLE_ADS_DAILY_COL, startDate, endDate, opts);
}

export async function saveInflationIndex(rows) {
  const firestore = getDb();
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const row of rows.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(INFLATION_INDEX_COL).doc(row.month), row);
    }
    await batch.commit();
  }
  invalidate(INFLATION_INDEX_COL);
  return { written: rows.length };
}

// Small collection (~one doc per month since Dec 2016) — read in full and
// indexed by "YYYY-MM" rather than range-queried, since every report build
// only needs to look up two specific months (current + prevYear).
export function getInflationIndexByMonth() {
  return cached(INFLATION_INDEX_COL, 'all', async () => {
    const firestore = getDb();
    const snap = await firestore.collection(INFLATION_INDEX_COL).get();
    const map = new Map();
    for (const doc of snap.docs) {
      map.set(doc.id, doc.data().index);
    }
    return map;
  });
}
