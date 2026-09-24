import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderInput } from '../feriaOrders.mjs';

const validInput = {
  sellerId: 'v1',
  sellerName: 'Ana',
  customer: { name: 'Juan Pérez', docNumber: '20304050607', phone: '11 5555-5555' },
  paymentMethod: 'efectivo',
  lines: [{ sku: 'BCT037MA', modelo: 'Organica s', condition: 'falla', qty: 1, unitPrice: 23791, location: 'exhibicion', delivery: 'ahora' }],
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
  const result = validateOrderInput({ ...validInput, customer: { name: '', docNumber: '20304050607', phone: '11 5555-5555' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cliente')));
});

test('rechaza un pedido sin DNI/CUIT del cliente', () => {
  const result = validateOrderInput({ ...validInput, customer: { name: 'Juan Pérez', docNumber: '', phone: '11 5555-5555' } });
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

// `null >= 0` es true en JS, así que un unitPrice null pasaba el chequeo
// viejo. Es el caso real: el módulo de precios devuelve null cuando ese SKU
// no tiene precio cargado para esa condición.
test('rechaza una línea con unitPrice null (SKU sin precio para esa condición)', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], unitPrice: null }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Precio inválido')));
});

// Misma familia: `'2' >= 0` también es true, así que una cantidad string
// (típica de un body JSON armado a mano) pasaba el chequeo viejo.
test('rechaza una línea con cantidad no numérica', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], qty: '2' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('cantidad')));
});

test('rechaza una línea sin SKU', () => {
  const result = validateOrderInput({ ...validInput, lines: [{ ...validInput.lines[0], sku: '' }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('SKU')));
});

test('acepta una línea con listPrice (precio de tabla sin descuento del medio de pago)', () => {
  const lines = [{ ...validInput.lines[0], listPrice: 27990 }];
  assert.deepEqual(validateOrderInput({ ...validInput, lines }), { valid: true, errors: [] });
});

test('rechaza un listPrice que no es un número válido', () => {
  const lines = [{ ...validInput.lines[0], listPrice: '27990' }];
  const result = validateOrderInput({ ...validInput, lines });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Precio de lista inválido/);
});

test('rechaza una línea sin ubicación ni forma de entrega', () => {
  const lines = [{ ...validInput.lines[0], location: undefined, delivery: undefined }];
  const result = validateOrderInput({ ...validInput, lines });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Ubicación inválida/);
});

test('con una línea de envío exige los datos de envío', () => {
  const lines = [{ ...validInput.lines[0], location: 'rolon', delivery: 'envio' }];
  assert.match(validateOrderInput({ ...validInput, lines }).errors.join(' '), /Falta la calle del envío/);
  const shipping = { street: 'Av. Siempreviva', number: '742', city: 'Tigre', zip: '1648', phone: '1155555555' };
  assert.deepEqual(validateOrderInput({ ...validInput, lines, shipping }), { valid: true, errors: [] });
});

test('rechaza un pedido sin teléfono del cliente', () => {
  const result = validateOrderInput({ ...validInput, customer: { ...validInput.customer, phone: '  ' } });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Falta el teléfono del cliente/);
});

test('rechaza un teléfono con menos de 8 dígitos', () => {
  const result = validateOrderInput({ ...validInput, customer: { ...validInput.customer, phone: '123-45' } });
  assert.match(result.errors.join(' '), /Teléfono inválido/);
});
