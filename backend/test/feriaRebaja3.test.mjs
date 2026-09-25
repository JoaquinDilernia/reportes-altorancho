import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablePrice, withRebaja, rebajaLevels, rebajaUpdate, computeFinalPrice } from '../feriaPricing.mjs';

const product = { sku: 'A', precioFalla: 10000, precioRebaja1Falla: 9000, precioRebaja2Falla: 8000, rebajaFallaActiva: 0 };

test('tablePrice: la rebaja 3 es el precio manual de esa condición', () => {
  assert.equal(tablePrice({ ...product, precioRebaja3Falla: 5000 }, 'falla', 3), 5000);
  assert.equal(tablePrice(product, 'falla', 3), null);
  assert.throws(() => tablePrice(product, 'falla', 4), /Nivel de rebaja inválido/);
});

test('rebajaLevels: la rebaja 3 aparece cuando tiene precio cargado', () => {
  assert.deepEqual(rebajaLevels(product, 'falla').map((l) => l.level), [0, 1, 2]);
  const levels = rebajaLevels({ ...product, precioRebaja3Falla: 5000 }, 'falla');
  assert.deepEqual(levels.map((l) => l.level), [0, 1, 2, 3]);
  assert.equal(levels[3].precios.transferencia, computeFinalPrice({ ...product, precioRebaja3Falla: 5000 }, 'falla', 3, 'transferencia'));
});

test('rebajaUpdate: activar 3 con precio lo guarda; sin precio usa el que ya estaba', () => {
  assert.deepEqual(rebajaUpdate(product, 'falla', 3, '4500'), { rebajaFallaActiva: 3, precioRebaja3Falla: 4500 });
  assert.deepEqual(rebajaUpdate({ ...product, precioRebaja3Falla: 5000 }, 'falla', 3), { rebajaFallaActiva: 3 });
  assert.throws(() => rebajaUpdate(product, 'falla', 3), /Cargá el precio/);
  assert.throws(() => rebajaUpdate(product, 'falla', 3, 0), /Precio inválido/);
  assert.deepEqual(rebajaUpdate(product, 'discontinuo', 1), { rebajaDiscontinuoActiva: 1 });
});

test('withRebaja acepta el nivel 3', () => {
  assert.equal(withRebaja(product, 'falla', 3).rebajaFallaActiva, 3);
});
