import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceRows, planPriceWrites, directDownloadUrl } from '../feriaPriceSync.mjs';

const row = (sku, extra = {}) => ({ SKU: sku, Modelo: 'Mesa', Color: 'Negro', 'Precio Falla': 100, 'Precio Discontinuo': 200, ...extra });

test('parsePriceRows: saltea filas sin precio (no se venden a $0) y la última fila repetida gana', () => {
  const { products, incomplete, duplicates } = parsePriceRows([
    row('abc001ne'),
    { SKU: 'MMA003DO', 'Precio Falla': 0, 'Precio Discontinuo': 0 },
    row('XYZ002BL', { 'Precio Falla': 0 }),
    row('ABC001NE', { Modelo: 'Mesa nueva' }),
    { Modelo: 'sin sku' },
  ]);
  assert.deepEqual([...products.keys()], ['ABC001NE']);
  assert.equal(products.get('ABC001NE').modelo, 'Mesa nueva');
  assert.deepEqual(incomplete, ['MMA003DO', 'XYZ002BL']);
  assert.equal(duplicates.length, 1);
});

test('planPriceWrites: nuevos arrancan sin rebaja; solo se actualiza lo que cambió', () => {
  const { products } = parsePriceRows([row('NEW001NE'), row('SAME01NE'), row('CHG001NE', { 'Precio Falla': 150 })]);
  const current = new Map([
    ['SAME01NE', { ...products.get('SAME01NE'), rebajaFallaActiva: 2 }],
    ['CHG001NE', { ...products.get('CHG001NE'), precioFalla: 100, rebajaFallaActiva: 1 }],
  ]);
  const { created, updated } = planPriceWrites(products, current);
  assert.deepEqual(created.map((c) => c.sku), ['NEW001NE']);
  assert.equal(created[0].doc.rebajaFallaActiva, 0);
  assert.deepEqual(updated.map((u) => u.sku), ['CHG001NE']);
  // La rebaja activa del existente no viaja en la actualización (merge).
  assert.equal(updated[0].doc.rebajaFallaActiva, undefined);
});

test('directDownloadUrl: link compartido de Dropbox → descarga directa', () => {
  const url = directDownloadUrl('https://www.dropbox.com/scl/fi/abc/Precios.xlsx?rlkey=k1&st=s1&dl=0');
  const u = new URL(url);
  assert.equal(u.searchParams.get('dl'), '1');
  assert.equal(u.searchParams.get('rlkey'), 'k1');
  assert.equal(u.searchParams.get('st'), null);
});
