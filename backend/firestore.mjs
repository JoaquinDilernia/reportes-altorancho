import 'dotenv/config';
import admin from 'firebase-admin';

let db;

function getDb() {
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

export async function saveSalesDocs(docs) {
  const firestore = getDb();
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(firestore.collection(SALES_COL).doc(doc.id), {
        ...doc,
        date: admin.firestore.Timestamp.fromDate(new Date(doc.date)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function querySalesByRange(channels, startDate, endDate) {
  const firestore = getDb();
  const start = admin.firestore.Timestamp.fromDate(new Date(`${startDate}T00:00:00Z`));
  const end = admin.firestore.Timestamp.fromDate(new Date(`${endDate}T23:59:59Z`));

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
      const docId = doc.sku.replace(/\//g, '__');
      batch.set(firestore.collection(PRODUCTS_COL).doc(docId), doc);
    }
    await batch.commit();
  }
  return { written: docs.length };
}

export async function getProductsBySku() {
  const firestore = getDb();
  const snap = await firestore.collection(PRODUCTS_COL).get();
  const map = new Map();
  for (const doc of snap.docs) map.set(doc.id, doc.data());
  return map;
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
