import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOrderNumber, buildCartLine, assertCartEditable, priceCartForSubmit, isSentOrder, reservationDeltas,
} from '../feriaLines.mjs';

const product = {
  sku: 'ALF029CG', modelo: 'Liso', precioFalla: 9990, precioRebaja1Falla: 7990, rebajaFallaActiva: 1,
  precioDiscontinuo: 20000, rebajaDiscontinuoActiva: 0, costoGalpon: 5000,
};

test('formatOrderNumber lleva el número del vendedor como prefijo', () => {
  assert.equal(formatOrderNumber(1, 2), 'F2-0001');
  assert.equal(formatOrderNumber(37, '12'), 'F12-0037');
});

test('buildCartLine: precio de lista con la rebaja activa, todavía sin medio de pago', () => {
  const line = buildCartLine(product, { condition: 'falla', qty: 1, location: 'fallados', delivery: 'ahora' }, []);
  assert.deepEqual(line, {
    lineId: 'L1', sku: 'ALF029CG', modelo: 'Liso', condition: 'falla', qty: 1,
    listPrice: 7990, unitPrice: 7990, unitCost: 5000, location: 'fallados', delivery: 'ahora', status: 'pendiente',
  });
  assert.equal(buildCartLine(product, { condition: 'discontinuo', qty: 1, location: 'rolon', delivery: 'retira_rolon' }, [line]).lineId, 'L2');
});

test('buildCartLine rechaza cantidad, ubicación o condición sin precio', () => {
  assert.throws(() => buildCartLine(product, { condition: 'falla', qty: 0, location: 'fallados', delivery: 'ahora' }, []), /Cantidad inválida/);
  assert.throws(() => buildCartLine(product, { condition: 'falla', qty: 1, location: 'exhibicion', delivery: 'ahora' }, []), /Falla sale de Fallados/);
  assert.throws(() => buildCartLine({ ...product, precioDiscontinuo: null }, { condition: 'discontinuo', qty: 1, location: 'rolon', delivery: 'retira_rolon' }, []), /no tiene precio/);
});

test('assertCartEditable: solo el vendedor dueño y solo mientras es carrito', () => {
  const cart = { status: 'carrito', sellerId: 'v1' };
  assert.doesNotThrow(() => assertCartEditable(cart, 'v1'));
  assert.throws(() => assertCartEditable(cart, 'v2'), /otro vendedor/);
  assert.throws(() => assertCartEditable({ ...cart, status: 'pendiente' }, 'v1'), /ya se mandó a caja/);
  assert.throws(() => assertCartEditable({ ...cart, status: 'descartado' }, 'v1'), /se vació/);
});

test('priceCartForSubmit: rebaja vigente al enviar + descuento del medio de pago', () => {
  const lines = [
    { lineId: 'L1', sku: 'ALF029CG', condition: 'falla', qty: 2, listPrice: 9990, unitPrice: 9990 },
    { lineId: 'L2', sku: 'ALF029CG', condition: 'discontinuo', qty: 1, listPrice: 20000, unitPrice: 20000 },
  ];
  const priced = priceCartForSubmit(lines, 'transferencia', () => product);
  assert.deepEqual(priced.map((l) => [l.listPrice, l.unitPrice]), [[7990, Math.round(7990 * 0.85)], [20000, 17000]]);
  assert.throws(() => priceCartForSubmit(lines, 'transferencia', () => null), /ya no está en la lista de precios/);
});

test('isSentOrder: carritos abiertos o vaciados no son pedidos para caja ni historial', () => {
  assert.equal(isSentOrder({ status: 'carrito' }), false);
  assert.equal(isSentOrder({ status: 'descartado' }), false);
  for (const status of ['pendiente', 'error', 'confirmado', 'cancelado']) assert.equal(isSentOrder({ status }), true);
});

test('un carrito reserva al agregar y devuelve al quitar o bajar cantidad', () => {
  const line = { lineId: 'L1', sku: 'A', qty: 2, location: 'exhibicion', status: 'pendiente', condition: 'discontinuo' };
  assert.deepEqual([...reservationDeltas([], [line])], [['A__exhibicion', 2]]);
  assert.deepEqual([...reservationDeltas([line], [{ ...line, qty: 1 }])], [['A__exhibicion', -1]]);
  assert.deepEqual([...reservationDeltas([line], [])], [['A__exhibicion', -2]]);
});
