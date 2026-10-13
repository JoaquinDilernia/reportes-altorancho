import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAvailability, appReservedFor } from '../posStock.mjs';
import { reservationKey } from '../posLines.mjs';

const skuById = new Map([[10, 'QUE001']]);
const freeStock = new Map([[10, new Map([[324, 1], [8, 0]])]]);

test('checkAvailability: la última unidad de exhibición la toma uno solo', () => {
  const deltas = new Map([[reservationKey(10, 324), 1]]);
  assert.deepEqual(checkAvailability(freeStock, new Map(), deltas, skuById), []);
  const yaReservada = new Map([[reservationKey(10, 324), 1]]);
  assert.deepEqual(checkAvailability(freeStock, yaReservada, deltas, skuById), ['QUE001: pediste 1 y quedan 0 en esa ubicación']);
});

test('checkAvailability: liberar nunca se bloquea', () => {
  const deltas = new Map([[reservationKey(10, 8), -3]]);
  assert.deepEqual(checkAvailability(freeStock, new Map(), deltas, skuById), []);
});

test('appReservedFor: reservas de la app de un producto por ubicación', () => {
  const reserved = new Map([[reservationKey(10, 8), 2], [reservationKey(11, 8), 5], [reservationKey(10, 174), 1]]);
  assert.deepEqual([...appReservedFor(reserved, 10)], [[8, 2], [174, 1]]);
});
