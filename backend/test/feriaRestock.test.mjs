import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restockLines, hasCancelledItems, applyRestock } from '../feriaLines.mjs';

const now = new Date('2026-10-02T12:00:00Z');
const line = (lineId, status, over = {}) => ({ lineId, sku: 'A', qty: 1, location: 'rolon', status, ...over });

test('restockLines: productos eliminados de un pedido vivo', () => {
  const order = { status: 'confirmado', lines: [line('L1', 'entregado'), line('L2', 'eliminado'), line('L3', 'pendiente')] };
  assert.deepEqual(restockLines(order).map((l) => l.lineId), ['L2']);
});

test('restockLines: en un pedido cancelado o anulado, también lo que no se había entregado', () => {
  const order = {
    status: 'cancelado',
    lines: [line('L1', 'entregado'), line('L2', 'eliminado'), line('L3', 'pendiente'), line('L4', 'enviado_feria')],
  };
  assert.deepEqual(restockLines(order).map((l) => l.lineId), ['L2', 'L3', 'L4']);
});

test('restockLines: los carritos no van (lo que no pasó por caja no se movió)', () => {
  assert.deepEqual(restockLines({ status: 'descartado', lines: [line('L1', 'pendiente')] }), []);
  assert.deepEqual(restockLines({ status: 'carrito', lines: [line('L1', 'eliminado')] }), []);
});

test('hasCancelledItems: marca el pedido para que aparezca en Cancelados', () => {
  assert.equal(hasCancelledItems({ status: 'confirmado', lines: [line('L1', 'pendiente')] }), false);
  assert.equal(hasCancelledItems({ status: 'pendiente', lines: [line('L1', 'pendiente'), line('L2', 'eliminado')] }), true);
});

test('applyRestock: guarda quién y cuándo; no dos veces ni en una línea que no corresponde', () => {
  const order = { status: 'cancelado', lines: [line('L1', 'pendiente'), line('L2', 'entregado')] };
  const lines = applyRestock(order, 'L1', { user: 'Rolón', now });
  assert.deepEqual(lines[0], { ...order.lines[0], restockedAt: now, restockedBy: 'Rolón' });
  assert.throws(() => applyRestock({ ...order, lines }, 'L1', { user: 'Rolón', now }), /ya se devolvió/);
  assert.throws(() => applyRestock(order, 'L2', { user: 'Rolón', now }), /no está cancelad/);
  assert.throws(() => applyRestock(order, 'L9', { user: 'Rolón', now }), /no encontrada/);
});
