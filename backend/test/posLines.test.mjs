import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLine, buildLine, editLine, reservationDeltas, reservationKey, formatOrderNumber, validateShipping, needsShipping,
} from '../posLines.mjs';

const ctx = { localId: 'LL', localeIds: ['LL', 'BL', 'AL'] };
const product = { productId: 10, sku: 'QUE001', name: 'Cajonera Queens', fullPrice: 1210, promoPrice: null, basePrice: 1210 };
const line = (over = {}) => ({ lineId: 'L1', productId: 10, sku: 'QUE001', qty: 1, origin: 'stock', delivery: 'ahora', pickupLocalId: null, status: 'activo', ...over });

test('validateLine: "se lo lleva ahora" solo desde el local', () => {
  assert.deepEqual(validateLine(line({ origin: 'exhibicion' }), ctx), []);
  assert.deepEqual(validateLine(line({ origin: 'rolon' }), ctx), ['QUE001: "Se lo lleva ahora" solo sale del local (Stock o Exhibición)']);
});

test('validateLine: retira en Rolón sale de Rolón; retira en otro local necesita otro local', () => {
  assert.deepEqual(validateLine(line({ origin: 'stock', delivery: 'retira_rolon' }), ctx), ['QUE001: "Retira en Rolón" sale de Rolón']);
  assert.deepEqual(validateLine(line({ origin: 'rolon', delivery: 'retira_otro_local', pickupLocalId: 'LL' }), ctx), ['QUE001: elegí en qué otro local retira']);
  assert.deepEqual(validateLine(line({ origin: 'rolon', delivery: 'retira_otro_local', pickupLocalId: 'AL' }), ctx), []);
});

test('validateLine: retira otro día en el local y envío aceptan cualquier origen', () => {
  for (const origin of ['stock', 'exhibicion', 'rolon']) {
    assert.deepEqual(validateLine(line({ origin, delivery: 'retira_local' }), ctx), []);
    assert.deepEqual(validateLine(line({ origin, delivery: 'envio' }), ctx), []);
  }
});

test('validateLine: cantidad entera positiva', () => {
  assert.deepEqual(validateLine(line({ qty: 0 }), ctx), ['QUE001: cantidad inválida']);
  assert.deepEqual(validateLine(line({ qty: 1.5 }), ctx), ['QUE001: cantidad inválida']);
});

test('buildLine: toma precios del catálogo y numera después de la mayor', () => {
  const built = buildLine(product, { qty: 2 }, [line({ lineId: 'L3' })], ctx);
  assert.equal(built.lineId, 'L4');
  assert.equal(built.basePrice, 1210);
  assert.equal(built.origin, 'stock');
  assert.equal(built.delivery, 'ahora');
  assert.equal(built.status, 'activo');
  assert.throws(() => buildLine(product, { origin: 'rolon', delivery: 'ahora' }, [], ctx), /solo sale del local/);
});

test('editLine: cambia origen/entrega/cantidad y revalida; no edita entregadas', () => {
  const edited = editLine(line(), { origin: 'rolon', delivery: 'envio', qty: 3 }, ctx);
  assert.equal(edited.origin, 'rolon');
  assert.equal(edited.qty, 3);
  assert.throws(() => editLine(line({ status: 'entregado' }), { qty: 2 }, ctx), /ya se entregó/);
});

test('reservationDeltas: el carrito reserva; confirmar libera (Odoo pasa a reservar)', () => {
  const locate = (origin) => ({ stock: 8, exhibicion: 324, rolon: 174 }[origin]);
  const lines = [line({ qty: 2 }), line({ lineId: 'L2', origin: 'rolon', delivery: 'envio' })];
  const created = reservationDeltas(null, { status: 'carrito', lines }, locate);
  assert.deepEqual([...created], [[reservationKey(10, 8), 2], [reservationKey(10, 174), 1]]);
  const confirmed = reservationDeltas({ status: 'pendiente', lines }, { status: 'confirmado', lines }, locate);
  assert.deepEqual([...confirmed], [[reservationKey(10, 8), -2], [reservationKey(10, 174), -1]]);
});

test('reservationDeltas: mover de origen devuelve en uno y toma en el otro; sin cambios → vacío', () => {
  const locate = (origin) => ({ stock: 8, exhibicion: 324, rolon: 174 }[origin]);
  const before = { status: 'pendiente', lines: [line()] };
  const after = { status: 'pendiente', lines: [line({ origin: 'exhibicion' })] };
  assert.deepEqual([...reservationDeltas(before, after, locate)], [[reservationKey(10, 8), -1], [reservationKey(10, 324), 1]]);
  assert.equal(reservationDeltas(before, before, locate).size, 0);
});

test('formatOrderNumber y envío', () => {
  assert.equal(formatOrderNumber('LL', 12), 'LL-0012');
  assert.equal(needsShipping([line({ delivery: 'envio' })]), true);
  assert.equal(needsShipping([line({ delivery: 'envio', status: 'eliminado' })]), false);
  assert.deepEqual(validateShipping({ street: 'Av. X', number: '1', city: 'CABA', zip: '1428', phone: '1155556666', amount: -1 }), ['Costo de envío inválido']);
  assert.deepEqual(validateShipping({ amount: 0 }).length, 5);
});

test('validateShipping: subida al domicilio opcional, número >= 0', () => {
  const ok = { street: 'Av. X', number: '1', city: 'CABA', zip: '1428', phone: '1155556666', amount: 0 };
  assert.deepEqual(validateShipping(ok), []);
  assert.deepEqual(validateShipping({ ...ok, homeServiceAmount: null }), []);
  assert.deepEqual(validateShipping({ ...ok, homeServiceAmount: 5000 }), []);
  assert.deepEqual(validateShipping({ ...ok, homeServiceAmount: -1 }), ['Subida al domicilio inválida']);
  assert.deepEqual(validateShipping({ ...ok, homeServiceAmount: '5000' }), ['Subida al domicilio inválida']);
});
