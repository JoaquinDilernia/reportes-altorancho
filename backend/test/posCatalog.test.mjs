import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFromItems, searchCatalog, buildCatalogProduct, freeByLocation, groupStock } from '../posCatalog.mjs';
import { DEFAULT_LOCALES, DEFAULT_SETTINGS } from '../posConfig.mjs';

const product = { id: 10, product_tmpl_id: [100, 'X'], lst_price: 1000 };

test('priceFromItems: ítem de variante gana sobre el de plantilla', () => {
  const items = [
    { applied_on: '1_product', product_tmpl_id: [100, 'X'], product_id: false, compute_price: 'fixed', fixed_price: 900 },
    { applied_on: '0_product_variant', product_tmpl_id: false, product_id: [10, 'X'], compute_price: 'fixed', fixed_price: 850 },
  ];
  assert.equal(priceFromItems(product, items), 850);
});

test('priceFromItems: porcentaje no soportado → null; sin ítem → null', () => {
  const items = [{ applied_on: '1_product', product_tmpl_id: [100, 'X'], product_id: false, compute_price: 'percentage', percent_price: 20 }];
  assert.equal(priceFromItems(product, items), null);
  assert.equal(priceFromItems(product, []), null);
});

const raw = { id: 10, name: 'Monitor', default_code: 'MSI042BG', product_tmpl_id: [100, 'X'], lst_price: 1 };
const variantItem = (price) => ({ applied_on: '0_product_variant', product_tmpl_id: false, product_id: [10, 'X'], compute_price: 'fixed', fixed_price: price });

test('buildCatalogProduct: full y promo con IVA, base = promo', () => {
  assert.deepEqual(buildCatalogProduct(raw, [variantItem(349990)], [variantItem(299990)]), {
    productId: 10, templateId: 100, sku: 'MSI042BG', name: 'Monitor',
    fullPrice: 349990, promoPrice: 299990, basePrice: 299990,
  });
});

test('buildCatalogProduct: sin ítem en la lista full → null', () => {
  assert.equal(buildCatalogProduct(raw, [], [variantItem(299990)]), null);
});

test('buildCatalogProduct: promo >= full → base = full', () => {
  const p = buildCatalogProduct(raw, [variantItem(1000)], [variantItem(1200)]);
  assert.equal(p.basePrice, 1000);
});

test('buildCatalogProduct: ítem porcentual en la lista full → null', () => {
  const pct = { applied_on: '1_product', product_tmpl_id: [100, 'X'], product_id: false, compute_price: 'percentage', percent_price: 20 };
  assert.equal(buildCatalogProduct(raw, [pct], []), null);
});

test('freeByLocation: cantidad menos lo reservado en Odoo, sumado por ubicación', () => {
  const quants = [
    { product_id: [10, 'X'], location_id: [8, 'LL/Stock'], quantity: 5, reserved_quantity: 2 },
    { product_id: [10, 'X'], location_id: [8, 'LL/Stock'], quantity: 1, reserved_quantity: 0 },
    { product_id: [10, 'X'], location_id: [174, 'RL/Stock'], quantity: 3, reserved_quantity: 3 },
  ];
  const result = freeByLocation(quants).get(10);
  assert.equal(result.get(8), 4);
  assert.equal(result.get(174), 0);
});

test('groupStock: local, Rolón, web y otros locales, descontando reservas de la app', () => {
  const freeByLoc = new Map([[8, 4], [324, 1], [174, 7], [150, 2], [372, 3], [379, 0], [397, 1], [415, 2]]);
  const appReserved = new Map([[8, 1], [174, 2]]);
  const view = groupStock({ freeByLoc, appReserved, locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS, localId: 'LL' });
  assert.deepEqual(view.local, { stock: 3, exhibicion: 1 });
  assert.equal(view.rolon, 5);
  assert.deepEqual(view.web, { qty: 2, unlimited: false });
  assert.deepEqual(view.otros, [{ localId: 'AL', name: 'Alcorta', qty: 3 }, { localId: 'BL', name: 'Belgrano', qty: 3 }]);
});

test('groupStock: stock web absurdo se muestra como "sin límite"', () => {
  const view = groupStock({
    freeByLoc: new Map([[150, 1900000000]]), appReserved: new Map(),
    locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS, localId: 'LL',
  });
  assert.deepEqual(view.web, { qty: null, unlimited: true });
});

test('priceFromItems: varios ítems vigentes → el de date_start más reciente; sin fecha al final', () => {
  const mk = (price, date_start) => ({ applied_on: '0_product_variant', product_id: [10, 'X'], compute_price: 'fixed', fixed_price: price, date_start });
  const items = [mk(100, false), mk(200, '2026-09-01 00:00:00'), mk(300, '2026-10-01 00:00:00')];
  assert.equal(priceFromItems(product, items), 300);
  assert.equal(priceFromItems(product, [mk(100, false), mk(200, '2026-09-01 00:00:00')]), 200);
});

test('searchCatalog: consulta de menos de 4 caracteres → [] sin llamar a Odoo', async () => {
  assert.deepEqual(await searchCatalog('abc', DEFAULT_SETTINGS), []);
  assert.deepEqual(await searchCatalog('  ab ', DEFAULT_SETTINGS), []);
});
