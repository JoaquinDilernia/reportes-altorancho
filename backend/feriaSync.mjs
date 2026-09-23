import { getDb } from './firestore.mjs';
import { findCancelledOrderIds } from './feriaOdoo.mjs';
import { closeConfirmedOrder } from './feriaOrders.mjs';

const SYNC_EVERY_MS = 5 * 60 * 1000;

// Pedidos de la app cuyo sale.order alguien canceló directo en Odoo: se
// cierran también en la app para liberar el stock que tenían reservado.
// Incluye los que quedaron en 'error' con pedido ya creado en Odoo (el cajero
// los resolvió cancelándolos allá). Dos queries de un solo campo: sin índice
// compuesto.
export async function syncCancelledOrders() {
  const db = getDb();
  const byOdooId = new Map();
  for (const status of ['confirmado', 'error']) {
    const snap = await db.collection('feria_orders').where('status', '==', status).get();
    for (const doc of snap.docs) {
      const { odooOrderId } = doc.data();
      if (odooOrderId) byOdooId.set(odooOrderId, doc.id);
    }
  }
  const cancelled = await findCancelledOrderIds([...byOdooId.keys()]);
  let closed = 0;
  for (const odooId of cancelled) {
    // Uno que falle no frena al resto: se reintenta en la próxima vuelta.
    try {
      await closeConfirmedOrder(byOdooId.get(odooId), 'Odoo', 'Cancelado en Odoo', { fromOdoo: true });
      closed += 1;
      console.log(`[feriaSync] pedido ${byOdooId.get(odooId)} (Odoo ${odooId}) cancelado en Odoo: cerrado en la app`);
    } catch (err) {
      console.error(`[feriaSync] no se pudo cerrar ${byOdooId.get(odooId)}:`, err.message);
    }
  }
  return closed;
}

export function startCancellationSync() {
  const run = () => syncCancelledOrders().catch((err) => console.error('[feriaSync] error:', err.message));
  setTimeout(run, 15 * 1000);
  setInterval(run, SYNC_EVERY_MS);
}
