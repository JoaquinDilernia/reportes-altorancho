import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALES, DEFAULT_SETTINGS, DEFAULT_PAYMENT_METHODS, validateLocale, validatePaymentMethod,
  resolveOdooPaymentName, originLocationId,
} from '../posConfig.mjs';

const lomas = DEFAULT_LOCALES.find((l) => l.id === 'LL');

test('valores iniciales: tres locales con sus ubicaciones de Odoo', () => {
  assert.deepEqual(DEFAULT_LOCALES.map((l) => l.id), ['LL', 'BL', 'AL']);
  assert.equal(lomas.stockLocationId, 8);
  assert.equal(lomas.exhibicionLocationId, 324);
  assert.equal(DEFAULT_LOCALES.find((l) => l.id === 'BL').invoiceJournalId, 65);
  assert.equal(DEFAULT_SETTINGS.rolon.locationId, 174);
});

test('valores iniciales: efectivo 15 %, transferencia 20 %, tarjetas 0 %', () => {
  const pct = Object.fromEntries(DEFAULT_PAYMENT_METHODS.map((m) => [m.id, m.discountPct]));
  assert.equal(pct.efectivo, 15);
  assert.equal(pct.transferencia, 20);
  assert.equal(pct.debito, 0);
  assert.equal(pct.credito, 0);
});

test('originLocationId: stock / exhibición del local, o Rolón', () => {
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'stock'), 8);
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'exhibicion'), 324);
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'rolon'), 174);
  assert.throws(() => originLocationId(lomas, DEFAULT_SETTINGS, 'web'), /Origen inválido/);
});

test('resolveOdooPaymentName: el detalle (cuotas) manda sobre el medio', () => {
  const credito = DEFAULT_PAYMENT_METHODS.find((m) => m.id === 'credito');
  assert.equal(resolveOdooPaymentName(credito, '6'), 'Mercado Pago 6 cuotas');
  assert.throws(() => resolveOdooPaymentName(credito, null), /Elegí el detalle/);
  const efectivo = DEFAULT_PAYMENT_METHODS.find((m) => m.id === 'efectivo');
  assert.equal(resolveOdooPaymentName(efectivo, null), 'Efectivo');
});

test('validateLocale: ids numéricos de Odoo obligatorios; diario opcional', () => {
  assert.deepEqual(validateLocale({ ...lomas, invoiceJournalId: null }), []);
  assert.deepEqual(validateLocale({ ...lomas, name: '', stockLocationId: 'x' }), ['Falta el nombre', 'Ubicación de stock inválida']);
});

test('validatePaymentMethod: descuento entre 0 y 100', () => {
  const m = { id: 'efectivo', label: 'Efectivo', discountPct: 120, odooName: 'Efectivo', details: [] };
  assert.deepEqual(validatePaymentMethod(m), ['El descuento tiene que estar entre 0 y 100']);
});
