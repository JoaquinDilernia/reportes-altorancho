import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leafOdooCategoryName, primaryTiendanubeCategory } from '../categories.mjs';

test('leafOdooCategoryName extracts the last path segment', () => {
  assert.equal(
    leafOdooCategoryName('All / Biblia/ BAZAR / COMEDOR / TEXTILES DE MESA Y ACCESORIOS / MANTEL / CARDON'),
    'CARDON'
  );
});

test('leafOdooCategoryName trims whitespace', () => {
  assert.equal(leafOdooCategoryName('All /  Sillas '), 'Sillas');
});

test('leafOdooCategoryName returns null for missing path', () => {
  assert.equal(leafOdooCategoryName(null), null);
  assert.equal(leafOdooCategoryName(undefined), null);
});

test('primaryTiendanubeCategory picks the first category name in Spanish', () => {
  const categories = [
    { name: { es: 'Iluminación' } },
    { name: { es: 'Lámparas colgantes' } },
  ];
  assert.equal(primaryTiendanubeCategory(categories), 'Iluminación');
});

test('primaryTiendanubeCategory returns null for empty or missing list', () => {
  assert.equal(primaryTiendanubeCategory([]), null);
  assert.equal(primaryTiendanubeCategory(undefined), null);
});
