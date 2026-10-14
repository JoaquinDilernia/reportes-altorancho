// test/posPricing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basePriceOf, paymentDiscountPct, principalPayment, computeTotals, netOfIva, withIva, extraDiscountAmount, round2,
} from '../posPricing.mjs';

const methodsById = new Map([
  ['efectivo', { id: 'efectivo', discountPct: 15 }],
  ['transferencia', { id: 'transferencia', discountPct: 20 }],
  ['credito', { id: 'credito', discountPct: 0 }],
]);

test('basePriceOf: promo si tiene y es menor; si no, full', () => {
  assert.equal(basePriceOf({ fullPrice: 1000, promoPrice: 800 }), 800);
  assert.equal(basePriceOf({ fullPrice: 1000, promoPrice: null }), 1000);
  assert.equal(basePriceOf({ fullPrice: 1000, promoPrice: 0 }), 1000);
  assert.equal(basePriceOf({ fullPrice: 1000, promoPrice: 1200 }), 1000);
});

test('IVA: ida y vuelta con 2 decimales', () => {
  assert.equal(withIva(1000), 1210);
  assert.equal(netOfIva(1210), 1000);
});

test('paymentDiscountPct: un medio → su %, varios → el menor, ninguno → 0', () => {
  assert.equal(paymentDiscountPct([{ methodId: 'transferencia' }], methodsById), 20);
  assert.equal(paymentDiscountPct([{ methodId: 'transferencia' }, { methodId: 'credito' }], methodsById), 0);
  assert.equal(paymentDiscountPct([{ methodId: 'transferencia' }, { methodId: 'efectivo' }], methodsById), 15);
  assert.equal(paymentDiscountPct([], methodsById), 0);
  assert.throws(() => paymentDiscountPct([{ methodId: 'bitcoin' }], methodsById), /Medio de pago inválido/);
});

test('principalPayment: el de menor descuento va a Odoo', () => {
  const p = principalPayment([{ methodId: 'transferencia' }, { methodId: 'credito', detailId: '6' }], methodsById);
  assert.deepEqual(p, { methodId: 'credito', detailId: '6' });
});

test('computeTotals: ejemplo del spec (100.000, efectivo 15 %, extra 10 %)', () => {
  const t = computeTotals({
    lines: [{ qty: 1, basePrice: 60000 }, { qty: 2, basePrice: 20000 }, { qty: 5, basePrice: 999, status: 'eliminado' }],
    payments: [{ methodId: 'efectivo' }], methodsById,
    extraDiscount: { type: 'pct', value: 10 }, shippingAmount: 0,
  });
  assert.equal(t.products, 100000);
  assert.equal(t.paymentDiscount, 15000);
  assert.equal(t.subtotal, 85000);
  assert.equal(t.extraDiscount, 8500);
  assert.equal(t.total, 76500);
  assert.equal(t.lineDiscountPct, 23.5);
});

test('computeTotals: el envío se suma al final sin descuentos', () => {
  const t = computeTotals({
    lines: [{ qty: 1, basePrice: 10000 }], payments: [{ methodId: 'transferencia' }], methodsById,
    extraDiscount: null, shippingAmount: 5000,
  });
  assert.equal(t.subtotal, 8000);
  assert.equal(t.shipping, 5000);
  assert.equal(t.total, 13000);
  assert.equal(t.lineDiscountPct, 20);
});

test('extraDiscountAmount: monto fijo nunca supera el subtotal', () => {
  assert.equal(extraDiscountAmount({ type: 'amount', value: 5000 }, 3000), 3000);
  assert.equal(extraDiscountAmount({ type: 'amount', value: 500 }, 3000), 500);
  assert.equal(extraDiscountAmount(null, 3000), 0);
});

test('computeTotals: pedido vacío no divide por cero', () => {
  const t = computeTotals({ lines: [], payments: [], methodsById, extraDiscount: { type: 'pct', value: 10 }, shippingAmount: 0 });
  assert.equal(t.total, 0);
  assert.equal(t.lineDiscountPct, 0);
});

test('round2: redondeo half-up real (1.005 → 1.01)', () => {
  assert.equal(round2(1.005), 1.01);
});

test('computeTotals: caso desparejo — el total de la app es el que calcula Odoo (2 decimales)', () => {
  const t = computeTotals({
    lines: [{ qty: 1, basePrice: 1234567 }], payments: [{ methodId: 'efectivo' }], methodsById,
    extraDiscount: { type: 'pct', value: 33 }, shippingAmount: 0,
  });
  assert.equal(t.lineDiscountPct, 43.05);
  assert.equal(t.total, round2(1234567 * (1 - 0.4305)));
  assert.equal(round2(t.products - t.paymentDiscount - t.extraDiscount + t.shipping), t.total);
});

test('extraDiscountAmount: valida tipo y valor', () => {
  assert.throws(() => extraDiscountAmount({ type: 'pct', value: 150 }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'pct', value: -1 }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'pct', value: 0 }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'amount', value: -5 }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'amount', value: NaN }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'pct', value: NaN }, 1000), /Descuento extra inválido/);
  assert.throws(() => extraDiscountAmount({ type: 'otro', value: 5 }, 1000), /Tipo de descuento inválido/);
});

test('paymentDiscountPct: medio mal configurado lanza error', () => {
  const bad = new Map([['x', { id: 'x' }]]);
  assert.throws(() => paymentDiscountPct([{ methodId: 'x' }], bad), /Medio de pago mal configurado: x/);
});

test('computeTotals: valida el envío', () => {
  const base = { lines: [{ qty: 1, basePrice: 1000 }], payments: [], methodsById, extraDiscount: null };
  assert.throws(() => computeTotals({ ...base, shippingAmount: -1 }), /Costo de envío inválido/);
  assert.throws(() => computeTotals({ ...base, shippingAmount: NaN }), /Costo de envío inválido/);
  assert.equal(computeTotals({ ...base, shippingAmount: null }).total, 1000);
});

test('computeTotals: 2370 con 15 % + 33 % — total redondea como Odoo (1349.72, no 1349.71)', () => {
  const t = computeTotals({
    lines: [{ qty: 1, basePrice: 2370 }], payments: [{ methodId: 'efectivo' }], methodsById,
    extraDiscount: { type: 'pct', value: 33 }, shippingAmount: 0,
  });
  assert.equal(t.lineDiscountPct, 43.05);
  assert.equal(t.total, 1349.72);
  assert.equal(round2(t.products - t.paymentDiscount - t.extraDiscount + t.shipping), t.total);
});

test('computeTotals: la subida al domicilio se suma al final, sin descuentos', () => {
  const t = computeTotals({
    lines: [{ qty: 1, basePrice: 10000 }], payments: [{ methodId: 'transferencia' }], methodsById,
    extraDiscount: { type: 'pct', value: 10 }, shippingAmount: 5000, homeServiceAmount: 3000,
  });
  assert.equal(t.homeService, 3000);
  assert.equal(t.lineDiscountPct, 28);
  assert.equal(t.total, round2(10000 * 0.72 + 5000 + 3000));
  assert.equal(computeTotals({ lines: [{ qty: 1, basePrice: 1000 }], payments: [{ methodId: 'efectivo' }], methodsById }).homeService, 0);
  assert.throws(() => computeTotals({ lines: [], payments: [], methodsById, homeServiceAmount: -1 }), /Subida al domicilio inválida/);
});
