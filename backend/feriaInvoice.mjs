import { findOrderInvoices, createInvoiceFromOrder, postInvoice, planInvoiceStep } from './feriaOdoo.mjs';
import { markOrderInvoiced, setInvoiceError } from './feriaOrders.mjs';
import { withOrderLock } from './feriaDelivery.mjs';

// Diario de facturas de la feria (Pto. 9 Web). Sin configurar, la
// facturación automática queda apagada.
export function feriaInvoiceJournalId() {
  return Number(process.env.ODOO_FERIA_INVOICE_JOURNAL_ID) || null;
}

const defaultDeps = () => ({
  journalId: feriaInvoiceJournalId(),
  findOrderInvoices, createInvoiceFromOrder, postInvoice, markOrderInvoiced, setInvoiceError,
});

// Factura una venta ya confirmada: Factura B a consumidor final, con CAE de
// AFIP. Nunca tira: la venta ya está hecha, así que un error (AFIP caído,
// por ejemplo) se guarda en el pedido y Caja lo reintenta. Es reintentable
// porque mira primero qué facturas tiene el pedido en Odoo.
export async function invoiceOrder(order, deps = defaultDeps()) {
  if (!deps.journalId) return { status: 'skipped' };
  // Mismo candado que "Hecho" y "Anular": dos reintentos a la vez no pueden
  // emitir dos facturas, ni anularse la venta a mitad de facturar.
  return withOrderLock(order.odooOrderId, async () => {
    try {
      let step = planInvoiceStep(await deps.findOrderInvoices(order.odooOrderId));
      if (step.action === 'create') {
        await deps.createInvoiceFromOrder(order.odooOrderId);
        step = planInvoiceStep(await deps.findOrderInvoices(order.odooOrderId));
        if (step.action === 'create') throw new Error('Odoo no creó la factura');
      }
      const invoice = step.action === 'done' ? step.invoice : await deps.postInvoice(step.invoiceId, deps.journalId);
      const saved = { invoiceId: invoice.id, invoiceName: invoice.name };
      await deps.markOrderInvoiced(order.id, saved);
      return { status: 'invoiced', ...saved };
    } catch (err) {
      const error = `La venta está confirmada pero no se pudo facturar: ${err.message}`;
      try {
        await deps.setInvoiceError(order.id, error);
      } catch (saveErr) {
        console.error('[feria] no se pudo guardar el error de facturación:', saveErr.message);
      }
      return { status: 'error', error };
    }
  });
}
