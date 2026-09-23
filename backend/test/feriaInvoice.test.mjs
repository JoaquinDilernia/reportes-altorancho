import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceOrder } from '../feriaInvoice.mjs';

const order = { id: 'abc', status: 'confirmado', odooOrderId: 60081 };

// Odoo y Firestore de mentira: registran qué se llamó.
function fakeDeps({ invoices = [], postError = null, journalId = 38 } = {}) {
  const calls = [];
  let current = [...invoices];
  return {
    calls,
    journalId,
    findOrderInvoices: async () => current,
    createInvoiceFromOrder: async (id) => { calls.push(['create', id]); current = [{ id: 900, state: 'draft', name: '/' }]; },
    postInvoice: async (id, journal) => {
      calls.push(['post', id, journal]);
      if (postError) throw new Error(postError);
      return { id, state: 'posted', name: 'FA-B 00009-00031962' };
    },
    markOrderInvoiced: async (id, inv) => calls.push(['invoiced', id, inv]),
    setInvoiceError: async (id, msg) => calls.push(['error', id, msg]),
  };
}

test('invoiceOrder: crea la factura desde el pedido, la valida en el diario de la feria y la guarda', async () => {
  const deps = fakeDeps();
  const result = await invoiceOrder(order, deps);
  assert.deepEqual(result, { status: 'invoiced', invoiceId: 900, invoiceName: 'FA-B 00009-00031962' });
  assert.deepEqual(deps.calls, [
    ['create', 60081],
    ['post', 900, 38],
    ['invoiced', 'abc', { invoiceId: 900, invoiceName: 'FA-B 00009-00031962' }],
  ]);
});

test('invoiceOrder: sin diario configurado no factura (facturación apagada)', async () => {
  const deps = fakeDeps({ journalId: null });
  assert.deepEqual(await invoiceOrder(order, deps), { status: 'skipped' });
  assert.deepEqual(deps.calls, []);
});

test('invoiceOrder: si AFIP rechaza, guarda el error para reintentar y no tira', async () => {
  const deps = fakeDeps({ postError: 'AFIP: servicio no disponible' });
  const result = await invoiceOrder(order, deps);
  assert.equal(result.status, 'error');
  assert.match(result.error, /AFIP: servicio no disponible/);
  assert.deepEqual(deps.calls.at(-1), ['error', 'abc', result.error]);
});

test('invoiceOrder: al reintentar valida la factura que quedó en borrador (no crea otra)', async () => {
  const deps = fakeDeps({ invoices: [{ id: 777, state: 'draft', name: '/' }] });
  await invoiceOrder(order, deps);
  assert.deepEqual(deps.calls.map((c) => c[0]), ['post', 'invoiced']);
  assert.equal(deps.calls[0][1], 777);
});

test('invoiceOrder: si Odoo ya tiene la factura validada, solo la guarda en la app', async () => {
  const deps = fakeDeps({ invoices: [{ id: 555, state: 'posted', name: 'FA-B 00009-1' }] });
  assert.deepEqual(await invoiceOrder(order, deps), { status: 'invoiced', invoiceId: 555, invoiceName: 'FA-B 00009-1' });
  assert.deepEqual(deps.calls, [['invoiced', 'abc', { invoiceId: 555, invoiceName: 'FA-B 00009-1' }]]);
});
