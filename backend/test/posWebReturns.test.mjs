import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES, TRANSITIONS, assertTransition, canEdit, validateDraft, businessDaysBetween,
  isLate, suggestedDestination, computeMoney, buildOdooNoteLines, historyEntry,
} from '../posWebReturns.mjs';

const settings = { webReturns: {
  windowBusinessDays: 30, holidays: [],
  destinations: [{ id: 'fallas', label: 'Fallas', locationId: 1 }, { id: 'ecommerce', label: 'Ecommerce', locationId: 2 }],
  defaultDestinationByReason: { falla: 'fallas', disconformidad: 'ecommerce' },
} };

const baseDraft = (over = {}) => ({
  kind: 'cambio', reason: 'disconformidad', channel: 'manual',
  customer: { name: ' Ana ', phone: '1155', address: 'Calle 1', zone: 'amba' },
  purchase: { source: 'web', ref: '123456' },
  returnLines: [{ productId: 1, qty: '1', unitValue: '100' }],
  newLines: [{ productId: 2, qty: 1, price: 120 }],
  evidence: [],
  logistics: { mode: 'retiro_domicilio' },
  ...over,
});

test('statuses y transiciones', () => {
  assert.equal(STATUSES.length, 8);
  assert.deepEqual(TRANSITIONS.close.from, ['recibida', 'reintegrada']);
  assert.equal(assertTransition({ status: 'pendiente_aprobacion' }, 'approve'), 'aprobada');
  assert.throws(() => assertTransition({ status: 'aprobada' }, 'approve'), /No se puede aprobar/);
  assert.throws(() => assertTransition({ status: 'aprobada' }, 'x'), /Acción desconocida: x/);
  assert.equal(assertTransition({ status: 'aprobada', money: { refundPending: 500 } }, 'receive'), 'reintegro_pendiente');
  assert.equal(assertTransition({ status: 'aprobada', money: { refundPending: 0 } }, 'receive'), 'recibida');
  assert.equal(canEdit({ status: 'pendiente_aprobacion' }), true);
  assert.equal(canEdit({ status: 'aprobada' }), false);
});

test('businessDaysBetween e isLate', () => {
  assert.equal(businessDaysBetween('2026-11-20', '2026-11-27', []), 5);
  assert.equal(businessDaysBetween('2026-12-04', '2026-12-09', ['2026-12-08']), 2);
  assert.equal(businessDaysBetween('2026-11-27', '2026-11-20', []), 0);
  assert.equal(businessDaysBetween('2026-11-20T01:00:00Z', '2026-11-27T12:00:00Z', []), 6); // 01:00Z = jueves 19 en Argentina
  const s = (n) => ({ webReturns: { windowBusinessDays: n, holidays: [] } });
  // 6 días hábiles tras el viernes 2026-11-20 -> hasta 2026-11-30 son 6
  assert.equal(isLate('2026-11-20', '2026-11-30', s(5)), true);
  assert.equal(isLate('2026-11-20', '2026-11-30', s(6)), false);
});

test('suggestedDestination', () => {
  assert.equal(suggestedDestination('falla', settings), 'fallas');
  assert.equal(suggestedDestination('disconformidad', settings), 'ecommerce');
});

test('computeMoney', () => {
  const r = (v) => [{ qty: 1, unitValue: v }];
  const n = (v) => [{ qty: 1, price: v }];
  assert.equal(computeMoney({ kind: 'cambio', returnLines: r(10000), newLines: n(12500), shippingCharge: 3000 }).differenceToCollect, 5500);
  assert.equal(computeMoney({ kind: 'cambio', returnLines: r(10000), newLines: n(8000), shippingCharge: 0 }).refundPending, 2000);
  const d = computeMoney({ kind: 'devolucion', returnLines: r(10000), newLines: [], shippingCharge: 0 });
  assert.equal(d.refundPending, 10000);
  assert.equal(d.newValue, 0);
});

test('validateDraft', () => {
  const ok = validateDraft(baseDraft(), { settings });
  assert.equal(ok.customer.name, 'Ana');
  assert.equal(ok.returnLines[0].qty, 1);
  assert.equal(ok.returnLines[0].destinationId, 'ecommerce');
  assert.equal(ok.logistics.payer, 'cliente');
  assert.equal(ok.logistics.shippingCharge, 0);
  assert.equal(validateDraft(baseDraft({ reason: 'falla', evidence: [{ storagePath: 'a' }] }), { settings }).logistics.payer, 'altorancho');
  assert.throws(() => validateDraft(baseDraft({ reason: 'falla' }), { settings }), /fotos o video/);
  assert.doesNotThrow(() => validateDraft(baseDraft({ reason: 'falla' }), { settings, requireEvidence: false }));
  assert.throws(() => validateDraft(baseDraft({ reason: '' }), { settings }), /Falta el motivo/);
  assert.throws(() => validateDraft(baseDraft({ returnLines: [] }), { settings }), /Elegí qué producto vuelve/);
  assert.throws(() => validateDraft(baseDraft({ newLines: [] }), { settings }), /Elegí el producto nuevo/);
  assert.throws(() => validateDraft(baseDraft({ logistics: {} }), { settings }), /Elegí cómo vuelve el producto/);
  assert.throws(() => validateDraft(baseDraft({ kind: 'otro' }), { settings }), /tipo/i);
});

test('buildOdooNoteLines', () => {
  const lines = buildOdooNoteLines({
    reason: 'falla', reasonLabel: 'Rotura', reasonNote: 'Llegó roto', productOrigin: 'IMPORTADO',
    customer: { name: 'Ana', phone: '1155', address: 'Calle 1' }, purchase: { ref: '123456' },
    logistics: { mode: 'retiro_domicilio' }, number: 'CW-000123',
  });
  assert.deepEqual(lines.slice(0, 3), ['IMPORTADO', 'ROTURA', 'ENVIO NUESTRO']);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /CAMBIO PEDIDO ORIGINAL 123456/);
  assert.ok(lines[3].endsWith('CW-000123'));
  const l2 = buildOdooNoteLines({ reason: 'disconformidad', customer: { name: 'B' }, purchase: { ref: '9' }, logistics: { mode: 'envio_cliente' }, number: 'CW-1' });
  assert.deepEqual(l2.slice(0, 2), ['DISCONFORMIDAD', 'ENVIO EXTERNO']);
  assert.ok(!/undefined|  /.test(l2[2]));
  assert.match(l2[2], /ENVIO NUBE/);
});

test('historyEntry', () => {
  const now = new Date();
  assert.deepEqual(historyEntry('approve', 'u', undefined, now), { at: now, by: 'u', action: 'approve', diff: null });
});
