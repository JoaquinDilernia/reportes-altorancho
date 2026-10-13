import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderKeys, validateCustomer, validatePayments, assertPaymentsMatchTotal, priceOrder, assertCartEditable, assertDraftEditable,
  orderGroups, joinOdooNames,
} from '../posOrders.mjs';

const methodsById = new Map([
  ['efectivo', { id: 'efectivo', label: 'Efectivo', discountPct: 15, details: [] }],
  ['credito', { id: 'credito', label: 'Tarjeta crédito', discountPct: 0, details: [{ id: '6', label: '6 cuotas', odooName: 'MP 6' }] }],
]);
const customer = { docNumber: '30123456', name: 'Ana Pérez', phone: '11 5555 6666', email: 'ana@mail.com', afipResponsibility: null };

test('orderKeys: claves para consultar sin índices compuestos', () => {
  const keys = orderKeys({ localId: 'LL', status: 'pendiente', createdAt: new Date('2026-10-13T12:00:00-03:00') });
  assert.deepEqual(keys, { queueKey: 'LL_pendiente', monthKey: 'LL_2026-10' });
});

test('validateCustomer: obligatorios y email/teléfono válidos', () => {
  assert.deepEqual(validateCustomer(customer, { wantsInvoice: false }), []);
  const errors = validateCustomer({ ...customer, phone: '123', email: 'x' }, { wantsInvoice: false });
  assert.deepEqual(errors, ['Teléfono inválido: tiene que tener al menos 8 números', 'Email inválido']);
});

test('validateCustomer: Factura A pide CUIT válido y condición de IVA', () => {
  const ri = { ...customer, docNumber: '30-71234567-1', afipResponsibility: null };
  assert.ok(validateCustomer(ri, { wantsInvoice: true }).includes('Para facturar a un CUIT falta la condición de IVA (buscalo en ARCA)'));
});

test('validatePayments: medios válidos, detalle obligatorio en crédito, montos en pago dividido', () => {
  assert.deepEqual(validatePayments([{ methodId: 'efectivo' }], methodsById), [{ methodId: 'efectivo', detailId: null, amount: null }]);
  assert.throws(() => validatePayments([{ methodId: 'credito' }], methodsById), /Elegí el detalle/);
  assert.throws(() => validatePayments([{ methodId: 'efectivo', amount: 10 }, { methodId: 'credito', detailId: '6' }], methodsById), /Monto inválido/);
  assert.throws(() => validatePayments([{ methodId: 'efectivo', amount: 1 }, { methodId: 'efectivo', amount: 1 }], methodsById), /repetido/);
});

test('assertPaymentsMatchTotal: si caja cambió algo después de dividir, frena', () => {
  const payments = [{ methodId: 'efectivo', amount: 500 }, { methodId: 'credito', detailId: '6', amount: 500 }];
  assert.doesNotThrow(() => assertPaymentsMatchTotal(payments, 1000));
  assert.throws(() => assertPaymentsMatchTotal(payments, 1210), /suman \$ 1\.000 y el total es \$ 1\.210/);
  assert.doesNotThrow(() => assertPaymentsMatchTotal([{ methodId: 'efectivo', amount: null }], 1210));
});

test('priceOrder: aplica la cascada con el descuento elegido', () => {
  const order = {
    lines: [{ qty: 1, basePrice: 100000, status: 'activo' }], payments: [{ methodId: 'efectivo' }],
    discountChoice: null, shipping: null, customer: { tagIds: [] },
  };
  const { totals, extraDiscount } = priceOrder(order, { methodsById, promotions: [], now: Date.now() });
  assert.equal(extraDiscount, null);
  assert.equal(totals.total, 85000);
});

test('assertCartEditable / assertDraftEditable', () => {
  assert.throws(() => assertCartEditable({ status: 'carrito', sellerId: 'a' }, { id: 'b' }), /otro vendedor/);
  assert.throws(() => assertCartEditable({ status: 'pendiente', sellerId: 'a', number: 'LL-0001' }, { id: 'a' }), /ya se mandó/);
  assert.throws(() => assertDraftEditable({ status: 'confirmado' }), /ya se confirmó/);
  assert.throws(() => assertDraftEditable({ status: 'error', odooOrderId: 5 }), /ya existe en Odoo/);
  assert.doesNotThrow(() => assertDraftEditable({ status: 'pendiente' }));
});

test('orderGroups: separa líneas activas por origen Rolón y excluye eliminadas', () => {
  const lines = [
    { lineId: 1, origin: 'stock', status: 'activo' },
    { lineId: 2, origin: 'rolon', status: 'activo' },
    { lineId: 3, origin: 'exhibicion', status: 'activo' },
    { lineId: 4, origin: 'rolon', status: 'eliminado' },
    { lineId: 5, origin: 'stock', status: 'eliminado' },
  ];
  const { local, rolon } = orderGroups(lines);
  assert.deepEqual(local.map((l) => l.lineId), [1, 3]);
  assert.deepEqual(rolon.map((l) => l.lineId), [2]);
  assert.deepEqual(orderGroups(undefined), { local: [], rolon: [] });
});

test('joinOdooNames: une nombres con " + " y saltea nulos', () => {
  assert.equal(joinOdooNames([{ group: 'local', odooOrderName: 'S10850' }, { group: 'rolon', odooOrderName: 'S10851' }]), 'S10850 + S10851');
  assert.equal(joinOdooNames([{ group: 'local', odooOrderName: null }, { group: 'rolon', odooOrderName: 'S2' }]), 'S2');
  assert.equal(joinOdooNames([]), '');
});
