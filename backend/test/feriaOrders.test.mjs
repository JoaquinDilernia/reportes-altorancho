import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderInput } from '../feriaOrders.mjs';

const validInput = {
  sellerId: 'v1',
  sellerName: 'Ana',
  customer: { name: 'Juan Pérez', docNumber: '20304050607' },
  paymentMethod: 'efectivo',
  lines: [{ sku: 'BCT037MA', modelo: 'Organica s', condition: 'falla', qty: 1, unitPrice: 23791 }],
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
  const result = validateOrderInput({ ...validInput, customer: { name: '', docNumber: '20304050607' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cliente')));
});

test('rechaza un pedido sin DNI/CUIT del cliente', () => {
  const result = validateOrderInput({ ...validInput, customer: { name: 'Juan Pérez', docNumber: '' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('DNI')));
});

test('rechaza método de pago inválido', () => {
  const result = validateOrderInput({ ...validInput, paymentMethod: 'cheque' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('pago')));
});

test('rechaza una línea con condición inválida', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], condition: 'nueva' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Condición')));
});

test('rechaza una línea con cantidad 0 o negativa', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], qty: 0 }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cantidad')));
});

test('rechaza una línea sin SKU', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], sku: '' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('SKU')));
});
