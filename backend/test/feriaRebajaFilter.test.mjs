import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByRebaja } from '../feriaProducts.mjs';

const products = [
  { sku: 'A', modelo: 'Mesa', precioFalla: 100, rebajaFallaActiva: 1, precioDiscontinuo: 200, rebajaDiscontinuoActiva: 0 },
  { sku: 'B', modelo: 'Silla', precioFalla: 100, rebajaFallaActiva: 0, precioDiscontinuo: 200, rebajaDiscontinuoActiva: 1 },
  { sku: 'C', modelo: 'Banco', precioFalla: 100, rebajaFallaActiva: 3, precioRebaja3Falla: 50 },
  { sku: 'D', modelo: 'Aparador', precioFalla: 100, rebajaFallaActiva: 0 },
  // Rebaja activa en una condición sin precio: no cuenta (no se vende así).
  { sku: 'E', modelo: 'Cómoda', precioFalla: 100, rebajaFallaActiva: 0, rebajaDiscontinuoActiva: 2 },
];

test('filterByRebaja: cuenta y lista los productos con esa rebaja activa en alguna condición', () => {
  const { counts, products: level1 } = filterByRebaja(products, 1);
  assert.deepEqual(counts, { 1: 2, 2: 0, 3: 1 });
  assert.deepEqual(level1.map((p) => p.sku), ['A', 'B'], 'ordenados por modelo (Mesa, Silla)');
  assert.deepEqual(filterByRebaja(products, 3).products.map((p) => p.sku), ['C']);
  assert.deepEqual(filterByRebaja(products, 2).products, []);
});

test('filterByRebaja: sin nivel solo devuelve los contadores', () => {
  const result = filterByRebaja(products, null);
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.counts, { 1: 2, 2: 0, 3: 1 });
});
