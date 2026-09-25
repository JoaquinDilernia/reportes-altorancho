// Reintento automático de los pedidos que fallaron al confirmar en Odoo
// (Odoo caído, se cortó la conexión): cada pocos minutos, con espera
// creciente y un tope (ver shouldAutoRetry). Mismo camino que el botón
// Reintentar de Caja, así que no puede duplicar una venta en Odoo.
import { getDb } from './firestore.mjs';
import { shouldAutoRetry } from './feriaLines.mjs';
import { recordAutoRetry } from './feriaOrders.mjs';
import { claimAndConfirm } from './feriaConfirm.mjs';
import { getCurrentCash } from './feriaCash.mjs';

const RETRY_EVERY_MS = 3 * 60 * 1000;
const RETRY_USER = 'Reintento automático';

export async function retryFailedOrders(now = Date.now()) {
  const snap = await getDb().collection('feria_orders').where('status', '==', 'error').get();
  const due = snap.docs.filter((d) => shouldAutoRetry(d.data(), now));
  if (!due.length) return { due: 0, confirmed: 0 };
  // Con la caja cerrada no se confirma nada: no se gastan intentos.
  if (!(await getCurrentCash()).session) return { due: due.length, confirmed: 0, cashClosed: true };
  let confirmed = 0;
  // De a uno: Odoo es lento y no conviene saturarlo justo cuando se recupera.
  for (const doc of due) {
    try {
      if (!(await recordAutoRetry(doc.id))) continue;
      const order = await claimAndConfirm(doc.id, RETRY_USER);
      confirmed += 1;
      console.log(`[feriaRetry] ${order.number ?? doc.id} confirmado en el reintento automático`);
    } catch (err) {
      // 'claim': caja cerrada, cancelado, alguien lo está confirmando… se
      // vuelve a mirar en la próxima vuelta.
      console.error(`[feriaRetry] ${doc.id} sigue sin confirmar (${err.stage ?? 'error'}): ${err.message}`);
    }
  }
  return { due: due.length, confirmed };
}

export function startAutoRetry() {
  const run = () => retryFailedOrders().catch((err) => console.error('[feriaRetry] error:', err.message));
  setInterval(run, RETRY_EVERY_MS);
}
