import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderInput } from '../feriaOrders.mjs';

const validInput = {
  sellerId: 'v1',
  sellerName: 'Ana',
  customer: { name: 'Juan Pérez', docNumber: '20304050607' },
  paymentMethod: 'efectivo',
  pricelistId: 7,
  pricelistName: 'Descuento efectivo',
  lines: [{ productId: 100, sku: 'ABC123', name: 'Silla Roma', qty: 1, unitPrice: 1000, discountPct: 0 }],
};

test('acepta un pedido completo y válido', () => {
  assert.deepEqual(validateOrderInput(validInput), { valid: true, errors: [] });
});

test('rechaza un pedido sin líneas', () => {
  const result = validateOrderInput({ ...validInput, lines: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('línea')));
});

test('rechaza un pedido sin nombre de cliente', () => {
  const result = validateOrderInput({ ...validInput, customer: { name: '', docNumber: '' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cliente')));
});

test('rechaza método de pago inválido', () => {
  const result = validateOrderInput({ ...validInput, paymentMethod: 'cheque' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('pago')));
});

test('rechaza una línea con cantidad 0 o negativa', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], qty: 0 }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cantidad')));
});
