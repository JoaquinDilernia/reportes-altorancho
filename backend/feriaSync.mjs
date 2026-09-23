import { getDb } from './firestore.mjs';
import { findCancelledOrderIds } from './feriaOdoo.mjs';
import { closeConfirmedOrder } from './feriaOrders.mjs';

const SYNC_EVERY_MS = 5 * 60 * 1000;

// Ventas confirmadas en la app que alguien canceló directo en Odoo: se
// cierran también en la app para liberar el stock que tenían reservado.
export async function syncCancelledOrders() {
  const db = getDb();
  const snap = await db.collection('feria_orders').where('status', '==', 'confirmado').get();
  const byOdooId = new Map();
  for (const doc of snap.docs) {
    const { odooOrderId } = doc.data();
    if (odooOrderId) byOdooId.set(odooOrderId, doc.id);
  }
  const cancelled = await findCancelledOrderIds([...byOdooId.keys()]);
  for (const odooId of cancelled) {
    await closeConfirmedOrder(byOdooId.get(odooId), 'Odoo', 'Cancelado en Odoo');
    console.log(`[feriaSync] pedido ${byOdooId.get(odooId)} (Odoo ${odooId}) cancelado en Odoo: cerrado en la app`);
  }
  return cancelled.length;
}

export function startCancellationSync() {
  const run = () => syncCancelledOrders().catch((err) => console.error('[feriaSync] error:', err.message));
  setTimeout(run, 15 * 1000);
  setInterval(run, SYNC_EVERY_MS);
}
