import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLineDelivery, validateShipping, needsShipping, isReserving,
  reservationKey, parseReservationKey, reservationDeltas, assignLineIds,
  applyLineAction, assertLineActionAllowed, hasPendingDeliveries, assertCancellable, shippingCostFor,
  formatOrderNumber, assertShippingEditable, buildAddedLine, nextLineId,
} from '../feriaLines.mjs';

const now = new Date('2026-09-23T15:00:00Z');
const base = { lineId: 'L1', sku: 'ALF029CG', qty: 1, location: 'exhibicion', delivery: 'ahora', status: 'pendiente' };

test('validateLineDelivery acepta una línea completa', () => {
  assert.deepEqual(validateLineDelivery(base), []);
});

test('validateLineDelivery rechaza ubicación o entrega inválidas', () => {
  assert.match(validateLineDelivery({ ...base, location: 'deposito' }).join(), /Ubicación inválida/);
  assert.match(validateLineDelivery({ ...base, delivery: 'flete' }).join(), /Forma de entrega inválida/);
});

test('"Se lleva ahora" solo puede salir de Exhibición', () => {
  assert.match(validateLineDelivery({ ...base, location: 'rolon' }).join(), /solo puede salir de Exhibición/);
});

test('validateShipping exige calle, número, localidad, CP y teléfono', () => {
  const ok = { street: 'Av. Siempreviva', number: '742', floor: '', city: 'Tigre', zip: '1648', phone: '1155555555', notes: '' };
  assert.deepEqual(validateShipping(ok), []);
  assert.equal(validateShipping({ ...ok, phone: '  ' }).length, 1);
  assert.equal(validateShipping(undefined).length, 5);
});

test('needsShipping mira solo líneas no eliminadas', () => {
  assert.equal(needsShipping([{ ...base, delivery: 'envio', status: 'eliminado' }]), false);
  assert.equal(needsShipping([{ ...base, delivery: 'envio' }]), true);
});

test('isReserving: pendiente y enviado_feria reservan; entregado, eliminado y líneas viejas sin estado no', () => {
  assert.equal(isReserving({ status: 'pendiente' }), true);
  assert.equal(isReserving({ status: 'enviado_feria' }), true);
  assert.equal(isReserving({ status: 'entregado' }), false);
  assert.equal(isReserving({ status: 'eliminado' }), false);
  assert.equal(isReserving({}), false);
});

test('reservationKey normaliza el SKU a mayúsculas y se puede volver a parsear', () => {
  assert.equal(reservationKey('alf029cg', 'rolon'), 'ALF029CG__rolon');
  assert.deepEqual(parseReservationKey('ALF029CG__rolon'), { sku: 'ALF029CG', location: 'rolon' });
});

test('reservationDeltas: crear un pedido suma, y dos líneas del mismo SKU+ubicación se acumulan', () => {
  const after = [base, { ...base, lineId: 'L2', qty: 2 }, { ...base, lineId: 'L3', location: 'rolon', delivery: 'envio' }];
  assert.deepEqual([...reservationDeltas([], after)], [['ALF029CG__exhibicion', 3], ['ALF029CG__rolon', 1]]);
});

test('reservationDeltas: entregar o eliminar libera, mover de ubicación traslada', () => {
  assert.deepEqual([...reservationDeltas([base], [{ ...base, status: 'entregado' }])], [['ALF029CG__exhibicion', -1]]);
  assert.deepEqual(
    [...reservationDeltas([base], [{ ...base, location: 'rolon', delivery: 'retira_rolon' }])],
    [['ALF029CG__exhibicion', -1], ['ALF029CG__rolon', 1]],
  );
  assert.deepEqual([...reservationDeltas([base], [{ ...base, delivery: 'retira_feria' }])], []);
});

test('assignLineIds numera y deja todo en pendiente', () => {
  const lines = assignLineIds([{ sku: 'A' }, { sku: 'B' }]);
  assert.deepEqual(lines.map((l) => [l.lineId, l.status]), [['L1', 'pendiente'], ['L2', 'pendiente']]);
});

test('applyLineAction remove / deliver guardan quién y cuándo', () => {
  const removed = applyLineAction(base, 'remove', { user: 'Caja', now });
  assert.equal(removed.status, 'eliminado');
  assert.equal(removed.removedBy, 'Caja');
  assert.equal(removed.removedAt, now);
  const delivered = applyLineAction(base, 'deliver', { user: 'Caja', now });
  assert.equal(delivered.status, 'entregado');
  assert.equal(delivered.deliveredBy, 'Caja');
});

test('applyLineAction sendToFeria solo para retira_feria pendiente', () => {
  const line = { ...base, location: 'rolon', delivery: 'retira_feria' };
  assert.equal(applyLineAction(line, 'sendToFeria', { user: 'Log', now }).status, 'enviado_feria');
  assert.throws(() => applyLineAction(base, 'sendToFeria', { user: 'Log', now }), /Solo se envían a la feria/);
});

test('applyLineAction no toca líneas ya entregadas o eliminadas', () => {
  assert.throws(() => applyLineAction({ ...base, status: 'entregado' }, 'deliver', { user: 'C', now }), /ya está entregada/);
  assert.throws(() => applyLineAction({ ...base, status: 'eliminado' }, 'edit', { user: 'C', now, changes: { location: 'rolon' } }), /eliminada/);
});

test('applyLineAction edit valida la combinación y vuelve a pendiente si deja de ser retira_feria', () => {
  const sent = { ...base, location: 'rolon', delivery: 'retira_feria', status: 'enviado_feria' };
  const edited = applyLineAction(sent, 'edit', { user: 'C', now, changes: { delivery: 'retira_rolon' } });
  assert.equal(edited.delivery, 'retira_rolon');
  assert.equal(edited.status, 'pendiente');
  assert.throws(() => applyLineAction(base, 'edit', { user: 'C', now, changes: { location: 'rolon' } }), /solo puede salir de Exhibición/);
});

test('assertLineActionAllowed: no se elimina después de confirmar ni la última línea', () => {
  const order = { status: 'confirmado', lines: [base, { ...base, lineId: 'L2' }] };
  assert.throws(() => assertLineActionAllowed(order, base, 'remove'), /Después de confirmar/);
  const single = { status: 'pendiente', lines: [base] };
  assert.throws(() => assertLineActionAllowed(single, base, 'remove'), /última línea/);
  assert.doesNotThrow(() => assertLineActionAllowed({ status: 'pendiente', lines: [base, { ...base, lineId: 'L2' }] }, base, 'remove'));
});

test('assertLineActionAllowed: "Hecho" exige pedido confirmado con línea en Odoo; cancelado bloquea todo', () => {
  assert.throws(() => assertLineActionAllowed({ status: 'pendiente', lines: [base] }, base, 'deliver'), /confirmar el pedido/);
  assert.doesNotThrow(() => assertLineActionAllowed({ status: 'confirmado', lines: [base] }, { ...base, odooLineId: 5 }, 'deliver'));
  assert.throws(() => assertLineActionAllowed({ status: 'cancelado', lines: [base] }, base, 'edit'), /cancelado/);
});

test('hasPendingDeliveries: true con una línea que reserva; false para pedidos viejos sin delivery/status', () => {
  assert.equal(hasPendingDeliveries({ lines: [{ ...base, delivery: 'retira_rolon' }] }), true);
  assert.equal(hasPendingDeliveries({ lines: [{ ...base, status: 'entregado' }] }), false);
  assert.equal(hasPendingDeliveries({ lines: [{ sku: 'ALF029CG', qty: 1, unitPrice: 7992 }] }), false);
});

test('assertLineActionAllowed: no se elimina una línea si el pedido ya existe en Odoo (reintento pendiente)', () => {
  const order = { status: 'error', odooOrderId: 60031, lines: [base, { ...base, lineId: 'L2' }] };
  assert.throws(() => assertLineActionAllowed(order, base, 'remove'), /ya existe en Odoo/);
});

test('assertCancellable: solo pedidos sin confirmar y que todavía no existen en Odoo', () => {
  assert.doesNotThrow(() => assertCancellable({ status: 'pendiente', odooOrderId: null }));
  assert.throws(() => assertCancellable({ status: 'confirmado', odooOrderId: 1 }), /Solo se cancelan/);
  assert.throws(() => assertCancellable({ status: 'error', odooOrderId: 60031 }), /ya existe en Odoo/);
});

test('assertLineActionAllowed: pasar a "Envío a domicilio" un pedido sin datos de envío antes de confirmar se rechaza', () => {
  const order = { status: 'pendiente', shipping: null, lines: [base] };
  assert.throws(() => assertLineActionAllowed(order, base, 'edit', { location: 'rolon', delivery: 'envio' }), /datos de envío/);
  const withShipping = { ...order, shipping: { street: 'x' } };
  assert.doesNotThrow(() => assertLineActionAllowed(withShipping, base, 'edit', { location: 'rolon', delivery: 'envio' }));
});

test('shippingCostFor: 10000 si queda alguna línea de envío activa, 0 si no', () => {
  assert.equal(shippingCostFor([{ ...base, delivery: 'envio' }]), 10000);
  assert.equal(shippingCostFor([{ ...base, delivery: 'envio', status: 'eliminado' }]), 0);
  assert.equal(shippingCostFor([base]), 0);
});

test('formatOrderNumber arma el número interno con 4 dígitos', () => {
  assert.equal(formatOrderNumber(1), 'F-0001');
  assert.equal(formatOrderNumber(128), 'F-0128');
  assert.equal(formatOrderNumber(12345), 'F-12345');
});

test('assertShippingEditable: se puede cargar dirección salvo en pedidos cancelados', () => {
  assert.doesNotThrow(() => assertShippingEditable({ status: 'pendiente' }));
  assert.doesNotThrow(() => assertShippingEditable({ status: 'confirmado', odooOrderId: 1 }));
  assert.throws(() => assertShippingEditable({ status: 'cancelado' }), /cancelado/);
});

test('applyLineAction edit cambia la cantidad y rechaza cantidades inválidas', () => {
  assert.equal(applyLineAction(base, 'edit', { user: 'C', now, changes: { qty: 3 } }).qty, 3);
  assert.throws(() => applyLineAction(base, 'edit', { user: 'C', now, changes: { qty: 0 } }), /Cantidad inválida/);
  assert.throws(() => applyLineAction(base, 'edit', { user: 'C', now, changes: { qty: 1.5 } }), /Cantidad inválida/);
});

test('reservationDeltas: subir la cantidad reserva la diferencia', () => {
  assert.deepEqual([...reservationDeltas([base], [{ ...base, qty: 3 }])], [['ALF029CG__exhibicion', 2]]);
});

test('assertLineActionAllowed: la cantidad no se cambia si el pedido ya existe en Odoo', () => {
  const order = { status: 'confirmado', odooOrderId: 1, lines: [base] };
  assert.throws(() => assertLineActionAllowed(order, base, 'edit', { qty: 2 }), /cantidad/);
  assert.doesNotThrow(() => assertLineActionAllowed({ status: 'pendiente', lines: [base] }, base, 'edit', { qty: 2 }));
});

test('nextLineId sigue la numeración aunque haya líneas eliminadas', () => {
  assert.equal(nextLineId([{ lineId: 'L1' }, { lineId: 'L3', status: 'eliminado' }]), 'L4');
  assert.equal(nextLineId([]), 'L1');
});

test('buildAddedLine arma la línea con precio de tabla (rebaja activa) y el descuento del medio de pago', () => {
  const product = { sku: 'ALF029CG', modelo: 'Liso', precioFalla: 9990, precioRebaja1Falla: 7990, rebajaFallaActiva: 1 };
  const line = buildAddedLine(product, { condition: 'falla', qty: 2, location: 'exhibicion', delivery: 'ahora' }, 'transferencia', [base]);
  assert.deepEqual(line, {
    lineId: 'L2', sku: 'ALF029CG', modelo: 'Liso', condition: 'falla', qty: 2,
    listPrice: 7990, unitPrice: Math.round(7990 * 0.85), location: 'exhibicion', delivery: 'ahora', status: 'pendiente',
  });
});

test('buildAddedLine rechaza condición sin precio o combinación inválida', () => {
  const product = { sku: 'X', modelo: 'X', precioFalla: null, precioDiscontinuo: 100 };
  assert.throws(() => buildAddedLine(product, { condition: 'falla', qty: 1, location: 'exhibicion', delivery: 'ahora' }, 'efectivo', []), /no tiene precio/);
  assert.throws(() => buildAddedLine(product, { condition: 'discontinuo', qty: 1, location: 'rolon', delivery: 'ahora' }, 'efectivo', []), /solo puede salir de Exhibición/);
});

test('"Retira en Rolón" solo puede salir de Rolón; retira en feria y envío desde cualquier ubicación', () => {
  assert.match(validateLineDelivery({ ...base, location: 'exhibicion', delivery: 'retira_rolon' }).join(), /solo puede salir de Rolón/);
  assert.deepEqual(validateLineDelivery({ ...base, location: 'rolon', delivery: 'retira_rolon' }), []);
  assert.deepEqual(validateLineDelivery({ ...base, location: 'exhibicion', delivery: 'retira_feria' }), []);
  assert.deepEqual(validateLineDelivery({ ...base, location: 'exhibicion', delivery: 'envio' }), []);
});
