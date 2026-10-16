import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxReturnable, validateReturnLine, buildReturnLine, editReturnLine, returnTotal, orderKind,
  appUnitValue, tpvUnitValue, webUnitValue, validateRefund, invoiceGroups,
} from '../posReturns.mjs';

const ctx = { destinationIds: ['stock', 'exhibicion'], reasons: ['Talle o medida', 'Otro'] };
const purchaseLine = (over = {}) => ({
  source: 'tpv', purchaseId: '48870', purchaseLabel: 'Alcorta/2301', purchaseLineId: '92250', productId: 68926, sku: 'IME031FS',
  name: 'Lámpara', qtyBought: 2, qtyReturnedBefore: 0, unitValue: 52990, lots: [], moveIds: [700],
  invoiceId: 368292, invoiceName: 'FA-B 00012-00001533', partnerVat: '30123456', partnerName: 'Ana', ...over,
});
const input = { qty: 1, destinationId: 'stock', reason: 'Talle o medida', reasonNote: '' };

test('maxReturnable: comprado menos lo ya devuelto', () => {
  assert.equal(maxReturnable(purchaseLine({ qtyBought: 3, qtyReturnedBefore: 1 })), 2);
});

test('buildReturnLine: arma la línea con id y valida', () => {
  const rl = buildReturnLine(purchaseLine(), input, [], ctx);
  assert.equal(rl.rlId, 'R1');
  assert.equal(rl.qty, 1);
  assert.equal(rl.unitValue, 52990);
  const second = buildReturnLine(purchaseLine({ purchaseLineId: '92251' }), input, [rl], ctx);
  assert.equal(second.rlId, 'R2');
});

test('buildReturnLine: la misma línea de compra no se agrega dos veces', () => {
  const rl = buildReturnLine(purchaseLine(), input, [], ctx);
  assert.throws(() => buildReturnLine(purchaseLine(), input, [rl], ctx), /ya está en lo que vuelve/);
});

test('validateReturnLine: tope, destino, motivo y "Otro" con texto', () => {
  const rl = { ...purchaseLine({ qtyReturnedBefore: 1 }), rlId: 'R1', qty: 2, destinationId: 'x', reason: 'Otro', reasonNote: '' };
  assert.deepEqual(validateReturnLine(rl, ctx), [
    'IME031FS: se pueden devolver hasta 1',
    'IME031FS: elegí el destino',
    'IME031FS: con "Otro" escribí el motivo',
  ]);
  assert.deepEqual(validateReturnLine({ ...rl, qty: 0, destinationId: 'stock', reason: 'Nada' }, ctx), [
    'IME031FS: cantidad inválida', 'IME031FS: elegí el motivo',
  ]);
});

test('editReturnLine: solo cantidad, destino y motivo', () => {
  const rl = buildReturnLine(purchaseLine(), input, [], ctx);
  const next = editReturnLine(rl, { qty: 2, destinationId: 'exhibicion', unitValue: 1 }, ctx);
  assert.equal(next.qty, 2);
  assert.equal(next.destinationId, 'exhibicion');
  assert.equal(next.unitValue, 52990);
  assert.throws(() => editReturnLine(rl, { qty: 3 }, ctx), /hasta 2/);
});

test('returnTotal y orderKind', () => {
  const r = [{ qty: 2, unitValue: 100.5 }, { qty: 1, unitValue: 10 }];
  assert.equal(returnTotal(r), 211);
  assert.equal(orderKind({ lines: [], returnLines: r }), 'devolucion');
  assert.equal(orderKind({ lines: [{ status: 'activo' }], returnLines: r }), 'cambio');
  assert.equal(orderKind({ lines: [{ status: 'eliminado' }], returnLines: r }), 'devolucion');
  assert.equal(orderKind({ lines: [{ status: 'activo' }], returnLines: [] }), 'venta');
});

test('valores unitarios por origen', () => {
  assert.equal(appUnitValue({ basePrice: 29990 }, 15), 25491.5);
  assert.equal(tpvUnitValue({ qty: 6, price_subtotal_incl: 81551.99 }), 13592);
  assert.equal(webUnitValue({ product_uom_qty: 1, price_total: 59990 }), 59990);
  assert.equal(tpvUnitValue({ qty: 0, price_subtotal_incl: 10 }), 0);
});

const methodsById = new Map([
  ['efectivo', { id: 'efectivo', label: 'Efectivo', active: true }],
  ['transferencia', { id: 'transferencia', label: 'Transferencia', active: true }],
]);

test('validateRefund: neto positivo o cero no lleva reintegro', () => {
  assert.equal(validateRefund(null, 100, methodsById), null);
  assert.equal(validateRefund({ cashBack: [], credit: 0 }, 0, methodsById), null);
});

test('validateRefund: reparte entre reintegro y saldo y tiene que sumar exacto', () => {
  assert.deepEqual(
    validateRefund({ cashBack: [{ methodId: 'efectivo', amount: 300 }], credit: 700 }, -1000, methodsById),
    { cashBack: [{ methodId: 'efectivo', amount: 300 }], credit: 700 },
  );
  assert.throws(() => validateRefund({ cashBack: [{ methodId: 'efectivo', amount: 300 }], credit: 0 }, -1000, methodsById),
    /El reintegro suma \$ 300 y hay que devolver \$ 1\.000/);
  assert.throws(() => validateRefund({ cashBack: [{ methodId: 'saldo', amount: 1000 }], credit: 0 }, -1000, methodsById), /Medio de reintegro inválido/);
  assert.throws(() => validateRefund({ cashBack: [{ methodId: 'efectivo', amount: 500 }, { methodId: 'efectivo', amount: 500 }], credit: 0 }, -1000, methodsById), /repetido/);
  assert.throws(() => validateRefund(null, -1000, methodsById), /Elegí cómo se devuelve/);
});

test('invoiceGroups: agrupa por factura original y saca las que no tienen', () => {
  const lines = [
    { rlId: 'R1', invoiceId: 1, invoiceName: 'FA-B 1' }, { rlId: 'R2', invoiceId: null },
    { rlId: 'R3', invoiceId: 1, invoiceName: 'FA-B 1' }, { rlId: 'R4', invoiceId: 2, invoiceName: 'FA-B 2' },
  ];
  assert.deepEqual(invoiceGroups(lines).map((g) => [g.invoiceId, g.lines.map((l) => l.rlId)]), [[1, ['R1', 'R3']], [2, ['R4']]]);
});
