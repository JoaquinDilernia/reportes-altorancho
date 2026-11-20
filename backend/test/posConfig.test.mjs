import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALES, DEFAULT_SETTINGS, DEFAULT_PAYMENT_METHODS, validateLocale, validatePaymentMethod,
  resolveOdooPaymentName, originLocationId, validateSettings,
  defaultReturnDestinations, returnDestinationsOf, findDestination,
  withLocaleDefaults, internalInvoiceJournalIdOf, isInternalJournal,
} from '../posConfig.mjs';

test('diario de venta interna por local: VINSI 85, VINBE 86, VINAL 87', () => {
  const ids = Object.fromEntries(DEFAULT_LOCALES.map((l) => [l.id, l.internalInvoiceJournalId]));
  assert.deepEqual(ids, { LL: 85, BL: 86, AL: 87 });
});

test('withLocaleDefaults: un local guardado sin diario de venta interna toma el inicial', () => {
  const { internalInvoiceJournalId: _omit, ...saved } = DEFAULT_LOCALES.find((l) => l.id === 'BL');
  assert.equal(withLocaleDefaults(saved).internalInvoiceJournalId, 86);
  assert.equal(withLocaleDefaults({ ...saved, internalInvoiceJournalId: 99 }).internalInvoiceJournalId, 99);
});

test('internalInvoiceJournalIdOf: el del local; si no tiene, el general de Ajustes', () => {
  assert.equal(internalInvoiceJournalIdOf(lomas, DEFAULT_SETTINGS), 85);
  assert.equal(internalInvoiceJournalIdOf({ ...lomas, internalInvoiceJournalId: null }, DEFAULT_SETTINGS), 28);
  assert.equal(internalInvoiceJournalIdOf({ ...lomas, internalInvoiceJournalId: null }, { ...DEFAULT_SETTINGS, internalInvoiceJournalId: null }), null);
});

test('validateLocale: diario de venta interna inválido', () => {
  assert.deepEqual(validateLocale({ ...lomas, internalInvoiceJournalId: null }), []);
  assert.ok(validateLocale({ ...lomas, internalInvoiceJournalId: 'x' }).includes('Diario de ventas internas inválido'));
});

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

test('defaultReturnDestinations: stock (por defecto), exhibición, enviar a Rolón y Fallas (Fall/Stock)', () => {
  const d = defaultReturnDestinations({ ...LL, returnDestinations: undefined }, DEFAULT_SETTINGS);
  assert.deepEqual(d.map((x) => [x.id, x.locationId, x.transferToLocationId, x.default]), [
    ['stock', 8, null, true], ['exhibicion', 324, null, false], ['rolon', 8, 174, false], ['fallas', 8, 192, false],
  ]);
  // Sin ubicación de fallas en Ajustes: no aparece.
  assert.ok(!defaultReturnDestinations(LL, { ...DEFAULT_SETTINGS, fallasLocationId: null }).some((x) => x.id === 'fallas'));
});

test('validateSettings: ubicación de fallas inválida', () => {
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, fallasLocationId: 'x' }).includes('Ubicación de fallas inválida'));
  assert.ok(!validateSettings({ ...DEFAULT_SETTINGS, fallasLocationId: null }).includes('Ubicación de fallas inválida'));
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

test('isInternalJournal: diarios de venta interna de los locales y el general', () => {
  assert.equal(isInternalJournal(86, DEFAULT_LOCALES, DEFAULT_SETTINGS), true);
  assert.equal(isInternalJournal(28, DEFAULT_LOCALES, DEFAULT_SETTINGS), true);
  assert.equal(isInternalJournal(32, DEFAULT_LOCALES, DEFAULT_SETTINGS), false);
  assert.equal(isInternalJournal(null, DEFAULT_LOCALES, DEFAULT_SETTINGS), false);
});

// ---- Cambios web ----
import { webReturnDestinationsOf, withSettingsDefaults } from '../posConfig.mjs';

test('webReturns: valores iniciales completos', () => {
  const w = DEFAULT_SETTINGS.webReturns;
  assert.equal(w.windowBusinessDays, 30);
  assert.deepEqual(w.destinations.map((d) => d.id), ['fallas', 'ecommerce', 'belgrano', 'lomas', 'rolon']);
  assert.deepEqual(w.defaultDestinationByReason, { falla: 'fallas', disconformidad: 'ecommerce' });
  assert.equal(webReturnDestinationsOf(DEFAULT_SETTINGS).length, 5);
});

test('validateSettings: ajustes guardados sin webReturns siguen siendo válidos', () => {
  const { webReturns: _omit, ...old } = DEFAULT_SETTINGS;
  assert.deepEqual(validateSettings(old), []);
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
});

test('validateSettings: plazo de cambios web inválido', () => {
  const bad = { ...DEFAULT_SETTINGS, webReturns: { ...DEFAULT_SETTINGS.webReturns, windowBusinessDays: 0 } };
  assert.match(validateSettings(bad).join('|'), /plazo/);
});

test('validateSettings: feriado mal formado', () => {
  const bad = { ...DEFAULT_SETTINGS, webReturns: { ...DEFAULT_SETTINGS.webReturns, holidays: ['2026-12-08', '8/12/2026'] } };
  assert.match(validateSettings(bad).join('|'), /feriado/);
  const ok = { ...DEFAULT_SETTINGS, webReturns: { ...DEFAULT_SETTINGS.webReturns, holidays: ['2026-12-08'] } };
  assert.deepEqual(validateSettings(ok), []);
});

test('validateSettings: destino con ubicación inválida', () => {
  const dests = [{ id: 'x', label: 'X', locationId: -3 }];
  const bad = { ...DEFAULT_SETTINGS, webReturns: { ...DEFAULT_SETTINGS.webReturns, destinations: dests } };
  assert.match(validateSettings(bad).join('|'), /destino/i);
});

test('webReturnDestinationsOf: filtra los destinos sin ubicación', () => {
  const s = { webReturns: { destinations: [
    { id: 'a', label: 'A', locationId: 5 }, { id: 'b', label: 'B', locationId: null },
  ] } };
  assert.deepEqual(webReturnDestinationsOf(s), [{ id: 'a', label: 'A', locationId: 5 }]);
  assert.deepEqual(webReturnDestinationsOf({}), []);
});

test('withSettingsDefaults: webReturns parcial conserva los defaults; el resto sigue igual', () => {
  const m = withSettingsDefaults({ returnWindowDays: 10, webReturns: { windowBusinessDays: 15 } });
  assert.equal(m.returnWindowDays, 10);
  assert.equal(m.fallasLocationId, 192);
  assert.equal(m.webReturns.windowBusinessDays, 15);
  assert.equal(m.webReturns.tagId, 18);
  assert.equal(m.webReturns.destinations.length, 5);
  assert.equal(withSettingsDefaults({}).webReturns.windowBusinessDays, 30);
});

// ---- saveSettings: nunca borra webReturns ----
import { saveSettings } from '../posConfig.mjs';
import { createFakeFirestore } from './helpers/fakeFirestore.mjs';

const { webReturns: _sinWeb, ...panelSettings } = DEFAULT_SETTINGS;
const storedOf = async (db) => (await db.collection('pos_settings').doc('general').get()).data();
const storedWeb = { ...DEFAULT_SETTINGS.webReturns, holidays: ['2026-12-08'], windowBusinessDays: 20, destinations: [{ id: 'fallas', label: 'Fallas', locationId: 192 }] };

test('saveSettings sin webReturns: conserva el guardado; sin guardado, igual que antes', async () => {
  const db = createFakeFirestore();
  await saveSettings({ ...panelSettings, returnWindowDays: 15 }, db);
  const first = await storedOf(db);
  assert.equal(first.returnWindowDays, 15);
  assert.equal('webReturns' in first, false, 'no inventa webReturns');
  await db.collection('pos_settings').doc('general').set({ ...first, webReturns: storedWeb });
  await saveSettings({ ...panelSettings, returnWindowDays: 20 }, db);
  const after = await storedOf(db);
  assert.equal(after.returnWindowDays, 20);
  assert.deepEqual(after.webReturns, storedWeb);
  await assert.rejects(saveSettings({ ...panelSettings, web: {} }, db), /Web: ubicación obligatoria/);
});

test('saveSettings con webReturns parcial: mezcla un nivel sobre lo guardado y los defaults', async () => {
  const db = createFakeFirestore();
  await db.collection('pos_settings').doc('general').set({ ...panelSettings, webReturns: { holidays: ['2026-12-08'], tagId: 99 } });
  await saveSettings({ ...panelSettings, webReturns: { windowBusinessDays: 25, holidays: ['2026-12-25'] } }, db);
  const w = (await storedOf(db)).webReturns;
  assert.equal(w.windowBusinessDays, 25);
  assert.deepEqual(w.holidays, ['2026-12-25']);
  assert.equal(w.tagId, 99, 'lo guardado que no vino se conserva');
  assert.deepEqual(w.destinations, DEFAULT_SETTINGS.webReturns.destinations, 'lo que falta sale de los defaults');
  assert.deepEqual(w.defaultDestinationByReason, DEFAULT_SETTINGS.webReturns.defaultDestinationByReason);
  await assert.rejects(saveSettings({ ...panelSettings, webReturns: { holidays: ['8/12'] } }, db), /feriado/);
  await assert.rejects(saveSettings({ ...panelSettings, webReturns: null }, db), /Cambios web: configuración inválida/);
  assert.deepEqual((await storedOf(db)).webReturns.holidays, ['2026-12-25'], 'si no valida no se guarda');
});
