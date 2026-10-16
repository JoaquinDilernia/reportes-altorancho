import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderKeys, validateCustomer, validatePayments, assertPaymentsMatchTotal, priceOrder, assertCartEditable, assertDraftEditable,
  orderGroups, joinOdooNames, claimPricing, assertCustomerShape,
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

test('claimPricing: con pedido ya en Odoo reusa precios guardados; sin Odoo recalcula', () => {
  const stored = { payments: [{ methodId: 'efectivo', detailId: null, amount: null }], extraDiscount: null, totals: { total: 123 } };
  const frozen = claimPricing(
    { ...stored, odooOrderId: 7, lines: [{ qty: 1, basePrice: 100000, status: 'activo' }], customer: { tagIds: [] } },
    { methodsById, promotions: [], now: Date.now() },
  );
  assert.equal(frozen.totals.total, 123);
  assert.deepEqual(frozen.payments, stored.payments);
  const fresh = claimPricing(
    { payments: [{ methodId: 'efectivo' }], odooOrderId: null, lines: [{ qty: 1, basePrice: 100000, status: 'activo' }], customer: { tagIds: [] }, totals: { total: 123 } },
    { methodsById, promotions: [], now: Date.now() },
  );
  assert.equal(fresh.totals.total, 85000);
});

test('assertCustomerShape: exige objeto con campos de texto', () => {
  assert.doesNotThrow(() => assertCustomerShape({ docNumber: '1', name: 'a', phone: '1', email: 'e' }));
  assert.throws(() => assertCustomerShape(null), /Datos del cliente inválidos/);
  assert.throws(() => assertCustomerShape({ docNumber: 5, name: 'a', phone: '1', email: 'e' }), /Datos del cliente inválidos/);
  assert.throws(() => assertCustomerShape({ name: 'a', phone: '1', email: 'e' }), /Datos del cliente inválidos/);
});

// ---- Fase 2: lo que vuelve ----
import { returnCtx, assertHolder, saldoAmount } from '../posOrders.mjs';
import { DEFAULT_LOCALES, DEFAULT_SETTINGS } from '../posConfig.mjs';

const exMethods = new Map([
  ['efectivo', { id: 'efectivo', label: 'Efectivo', discountPct: 15, details: [] }],
  ['saldo', { id: 'saldo', label: 'Saldo a favor', discountPct: 0, details: [] }],
]);
const rl = { rlId: 'R1', source: 'tpv', qty: 1, unitValue: 20000, partnerVat: '30123456', destinationId: 'stock' };

test('priceOrder: con lo que vuelve calcula el cambio (descuento sobre la diferencia)', () => {
  const order = {
    lines: [{ lineId: 'L1', status: 'activo', qty: 1, basePrice: 30000, delivery: 'ahora' }],
    returnLines: [rl], payments: [{ methodId: 'efectivo' }], customer: { tagIds: [] },
  };
  const { totals } = priceOrder(order, { methodsById: exMethods, promotions: [], now: Date.now() });
  assert.equal(totals.net, 8500);
  assert.equal(totals.collect, 8500);
});

test('claimPricing: devolución sola no pide medio de pago; cambio cobra solo el neto', () => {
  const devolucion = { lines: [], returnLines: [rl], payments: [], customer: { tagIds: [] } };
  const a = claimPricing(devolucion, { methodsById: exMethods, promotions: [], now: Date.now() });
  assert.deepEqual(a.payments, []);
  assert.equal(a.totals.net, -20000);
  const cambio = {
    lines: [{ lineId: 'L1', status: 'activo', qty: 1, basePrice: 30000, delivery: 'ahora' }], returnLines: [rl],
    payments: [{ methodId: 'efectivo', amount: 4000 }, { methodId: 'saldo', amount: 4500 }], customer: { tagIds: [] },
  };
  // con saldo en el pago dividido manda el 0 %: neto 10.000 sin descuento
  assert.throws(() => claimPricing(cambio, { methodsById: exMethods, promotions: [], now: Date.now() }), /suman \$ 8\.500 y el total es \$ 10\.000/);
});

test('returnCtx: destinos del local y motivos de ajustes', () => {
  const c = returnCtx(DEFAULT_LOCALES[0], DEFAULT_SETTINGS);
  assert.deepEqual(c.destinationIds, ['stock', 'exhibicion', 'rolon']);
  assert.deepEqual(c.reasons, DEFAULT_SETTINGS.returnReasons);
});

test('assertHolder: si la compra es de otro documento pide motivo', () => {
  const order = { customer: { docNumber: '30123456' }, returnLines: [rl], holderChangeReason: '' };
  assert.doesNotThrow(() => assertHolder(order));
  const other = { ...order, customer: { docNumber: '99888777' } };
  assert.throws(() => assertHolder(other), /La compra es de otro cliente/);
  assert.doesNotThrow(() => assertHolder({ ...other, holderChangeReason: 'Regalo, viene la hija' }));
  assert.doesNotThrow(() => assertHolder({ ...other, returnLines: [{ ...rl, partnerVat: null }] }));
});

test('saldoAmount: único medio usa lo que se cobra; dividido usa su monto', () => {
  assert.equal(saldoAmount([{ methodId: 'saldo', amount: null }], { collect: 7000, total: 9000 }), 7000);
  assert.equal(saldoAmount([{ methodId: 'efectivo', amount: 2000 }, { methodId: 'saldo', amount: 5000 }], { total: 7000 }), 5000);
  assert.equal(saldoAmount([{ methodId: 'efectivo', amount: null }], { total: 7000 }), 0);
});

import { assertPaymentsEditable } from '../posOrders.mjs';

test('assertPaymentsEditable: con saldo ya descontado no se cambia el pago', () => {
  const withAlloc = { creditAllocation: [{ creditId: 'c1', amount: 5000 }] };
  assert.throws(() => assertPaymentsEditable(withAlloc, { payments: [] }), /ya se descontó/);
  assert.doesNotThrow(() => assertPaymentsEditable({ creditAllocation: null }, { payments: [] }));
  assert.doesNotThrow(() => assertPaymentsEditable(withAlloc, { notes: 'x' }));
});

import { assertReturnLinesEditable, hasReturnDocsInOdoo } from '../posOrders.mjs';

test('assertReturnLinesEditable: con el plan de devolución guardado no se cambia lo que vuelve', () => {
  assert.doesNotThrow(() => assertReturnLinesEditable({ returnSteps: {} }));
  assert.doesNotThrow(() => assertReturnLinesEditable({}));
  assert.throws(() => assertReturnLinesEditable({ returnSteps: { plan: { pickings: [], manuals: [], transfers: [] } } }), /ya empezó a cargarse en Odoo/);
});

test('hasReturnDocsInOdoo: solo cuenta remitos, traslados o NC creados; el plan solo no', () => {
  assert.equal(hasReturnDocsInOdoo(undefined), false);
  assert.equal(hasReturnDocsInOdoo({ plan: { pickings: [] }, pickings: {}, transfers: {}, creditNotes: {} }), false);
  assert.equal(hasReturnDocsInOdoo({ pickings: { 'pick:x': { id: 1 } } }), true);
  assert.equal(hasReturnDocsInOdoo({ transfers: { 'transfer:rolon': { id: 2 } } }), true);
  assert.equal(hasReturnDocsInOdoo({ creditNotes: { 'nc:1': { id: 3 } } }), true);
});

import { cleanHolderReason } from '../posOrders.mjs';

test('cleanHolderReason: solo con algo que vuelve, recortado a 200', () => {
  const rl = [{ rlId: 'R1' }];
  assert.equal(cleanHolderReason('  Es la hermana  ', rl), 'Es la hermana');
  assert.equal(cleanHolderReason('x'.repeat(250), rl).length, 200);
  assert.equal(cleanHolderReason('Motivo', []), '');
  assert.equal(cleanHolderReason(undefined, rl), '');
});
