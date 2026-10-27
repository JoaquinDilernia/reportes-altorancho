import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALES, DEFAULT_SETTINGS, DEFAULT_PAYMENT_METHODS, validateLocale, validatePaymentMethod,
  resolveOdooPaymentName, originLocationId, validateSettings,
  defaultReturnDestinations, returnDestinationsOf, findDestination,
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

test('originLocationId: stock / exhibición del local, Rolón o web', () => {
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'stock'), 8);
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'exhibicion'), 324);
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'rolon'), 174);
  assert.equal(originLocationId(lomas, DEFAULT_SETTINGS, 'web'), 150);
  assert.throws(() => originLocationId(lomas, DEFAULT_SETTINGS, 'otro'), /Origen inválido/);
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

test('validateSettings: orderPricelistId opcional, entero positivo', () => {
  const ok = { rolon: { warehouseId: 1, locationId: 2 }, web: { locationId: 3 }, shippingProductSku: 'X' };
  assert.deepEqual(validateSettings({ ...ok, orderPricelistId: 314 }), []);
  assert.deepEqual(validateSettings(ok), []);
  assert.equal(validateSettings({ ...ok, orderPricelistId: -1 }).length, 1);
});

test('validateSettings: SKU y monto de subida al domicilio', () => {
  const ok = { rolon: { warehouseId: 1, locationId: 2 }, web: { locationId: 3 }, shippingProductSku: 'X' };
  assert.equal(DEFAULT_SETTINGS.homeServiceSku, 'SERVIDOM');
  assert.equal(DEFAULT_SETTINGS.homeServiceDefaultAmount, 5000);
  assert.deepEqual(validateSettings({ ...ok, homeServiceSku: 'SERVIDOM', homeServiceDefaultAmount: 0 }), []);
  assert.equal(validateSettings({ ...ok, homeServiceSku: ' ' }).length, 1);
  assert.equal(validateSettings({ ...ok, homeServiceDefaultAmount: -5 }).length, 1);
  assert.equal(validateSettings({ ...ok, homeServiceDefaultAmount: 'x' }).length, 1);
});

const LL = DEFAULT_LOCALES.find((l) => l.id === 'LL');

test('defaultReturnDestinations: stock (por defecto), exhibición y enviar a Rolón', () => {
  const d = defaultReturnDestinations({ ...LL, returnDestinations: undefined }, DEFAULT_SETTINGS);
  assert.deepEqual(d.map((x) => [x.id, x.locationId, x.transferToLocationId, x.default]), [
    ['stock', 8, null, true], ['exhibicion', 324, null, false], ['rolon', 8, 174, false],
  ]);
});

test('returnDestinationsOf: usa los del local (solo activos) y si no hay, los por defecto', () => {
  const own = [
    { id: 'fallas', label: 'Fallas', locationId: 392, transferToLocationId: null, default: true, active: true },
    { id: 'viejo', label: 'Viejo', locationId: 8, transferToLocationId: null, default: false, active: false },
  ];
  assert.deepEqual(returnDestinationsOf({ ...LL, returnDestinations: own }, DEFAULT_SETTINGS).map((d) => d.id), ['fallas']);
  assert.equal(returnDestinationsOf({ ...LL, returnDestinations: [] }, DEFAULT_SETTINGS)[0].id, 'stock');
});

test('findDestination: id desconocido tira', () => {
  assert.equal(findDestination(LL, DEFAULT_SETTINGS, 'exhibicion').locationId, 324);
  assert.throws(() => findDestination(LL, DEFAULT_SETTINGS, 'nope'), /Destino de devolución inválido/);
});

test('validateLocale: destinos y tipos de remito', () => {
  assert.deepEqual(validateLocale(LL), []);
  const bad = {
    ...LL, returnPickingTypeId: 0,
    returnDestinations: [
      { id: 'a', label: '', locationId: 8, transferToLocationId: null, default: true, active: true },
      { id: 'a', label: 'B', locationId: 0, transferToLocationId: 'x', default: true, active: true },
    ],
  };
  assert.deepEqual(validateLocale(bad), [
    'Tipo de remito de devolución inválido',
    'Destino de devolución: falta el nombre',
    'Destino de devolución "B": ubicación inválida',
    'Destino de devolución "B": depósito de traslado inválido',
    'Destino de devolución repetido: a',
    'Tiene que haber un solo destino de devolución por defecto',
  ]);
});

test('validateSettings: saldo, motivos y días de búsqueda', () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, creditValidityDays: 0, returnReasons: [], returnSearchDays: 5000, creditOdooPaymentName: '' }), [
    'Días de validez del saldo: entre 1 y 3650, o vacío para que no venza',
    'Cargá al menos un motivo de devolución',
    'Días de búsqueda de compras: entre 1 y 1095',
    'Medio de Odoo para saldo a favor inválido',
  ]);
});
