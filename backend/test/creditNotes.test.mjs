import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOdooCreditNote } from '../normalize.mjs';
import { creditNoteChannel, channelOfOrder } from '../sync/creditNotes.mjs';
import { computeTotals, computeDailyBreakdown, computeTopProducts } from '../aggregate.mjs';
import { feriaTeams } from '../mayoristaTab.mjs';
import { localesByHour } from '../localesTab.mjs';

const cats = new Map([['MML007BT', 'Dormitorio']]);
const line = (over) => ({
  display_type: 'product', product_id: [1, '[MML007BT] MESA DE LUZ'], quantity: 2,
  price_unit: 619826.45, price_subtotal: 991722.32, sale_line_ids: [10], ...over,
});
const move = (over) => ({
  id: 379489, name: 'NC-B 00009-00001320', state: 'posted', invoice_date: '2026-10-15', date: '2026-10-15',
  create_date: '2026-10-15 18:30:00', amount_total: 1200000, amount_untaxed: 991722.32, amount_residual: 0,
  team_id: [1, 'Tienda Nube'], pos_order_ids: [], ...over,
});

test('NC de ecommerce: negativa, sin IVA y sin envío, unidades en negativo', () => {
  const lines = [line(), line({ product_id: [4, '[Delivery_007] Envío'], quantity: 1, price_unit: 5000, price_subtotal: 5000 })];
  const doc = normalizeOdooCreditNote(move({ amount_untaxed: 996722.32 }), lines, 'ecommerce', cats);
  assert.equal(doc.id, 'refund_379489');
  assert.equal(doc.kind, 'refund');
  assert.equal(doc.status, 'completed');
  assert.equal(doc.total, -991722.32);
  assert.equal(doc.shippingRevenue, -5000);
  assert.deepEqual(doc.items, [{ sku: 'MML007BT', name: 'MESA DE LUZ', category: 'Dormitorio', qty: -2, unitPrice: 495861.16 }]);
  assert.equal(doc.date, '2026-10-15 18:30:00');
});

test('NC de mayorista: con IVA y descuenta lo conciliado de lo cobrado', () => {
  const doc = normalizeOdooCreditNote(move({ amount_total: 1000, amount_residual: 200 }), [line()], 'mayorista', cats);
  assert.equal(doc.total, -1000);
  assert.equal(doc.amountCollected, -800);
  assert.equal(doc.items[0].unitPrice, 619826.45);
});

test('NC no publicada queda void; creada otro día cuenta al mediodía de su fecha', () => {
  const doc = normalizeOdooCreditNote(move({ state: 'cancel', create_date: '2026-10-20 12:00:00' }), [], 'mayorista', cats);
  assert.equal(doc.status, 'void');
  assert.equal(doc.date, '2026-10-15 15:00:00');
});

test('canal: por el pedido original, con las mismas reglas que los syncs de ventas', () => {
  assert.equal(channelOfOrder({ team_id: [1, 'TN'], tiendanube_order_id: '123' }), 'ecommerce');
  assert.equal(channelOfOrder({ team_id: [1, 'TN'], tiendanube_order_id: false }), null);
  assert.equal(channelOfOrder({ team_id: [8, 'May'] }), 'mayorista');
  assert.equal(channelOfOrder({ team_id: [10, 'Presentes'] }), 'feria');
  assert.equal(channelOfOrder({ team_id: [6, 'Lomas'], client_order_ref: 'LL-0001' }), 'local_lomas');
  assert.equal(channelOfOrder({ team_id: [6, 'Lomas'], client_order_ref: false }), null);
});

test('canal: NC del Punto de Venta de Odoo se saltea (ya es un pos.order negativo)', () => {
  assert.equal(creditNoteChannel(move({ pos_order_ids: [55] }), []), null);
});

test('canal: sin pedido vinculado usa el equipo de la NC; pedido no contado → no cuenta', () => {
  assert.deepEqual(creditNoteChannel(move({ team_id: [6, 'Lomas'] }), []), { channel: 'local_lomas', team: [6, 'Lomas'] });
  assert.equal(creditNoteChannel(move({ team_id: [99, 'Venta interna'] }), []), null);
  assert.equal(creditNoteChannel(move(), [{ team_id: [1, 'TN'], tiendanube_order_id: false }]), null);
  assert.deepEqual(creditNoteChannel(move(), [{ team_id: [10, 'Presentes'] }]), { channel: 'feria', team: [10, 'Presentes'] });
});

const sale = { id: 'ecommerce_1', channel: 'ecommerce', status: 'completed', date: '2026-10-10T15:00:00.000Z', total: 1000, items: [{ sku: 'A', name: 'A', qty: 2, unitPrice: 500 }] };
const refund = { id: 'refund_1', channel: 'ecommerce', kind: 'refund', status: 'completed', date: '2026-10-12T15:00:00.000Z', total: -500, items: [{ sku: 'A', name: 'A', qty: -1, unitPrice: 500 }] };
const voided = { ...refund, id: 'refund_2', status: 'void' };

test('totales: la NC resta facturación y unidades, pero no es un pedido ni un día de venta', () => {
  const t = computeTotals([sale, refund, voided]);
  assert.equal(t.revenue, 500);
  assert.equal(t.units, 1);
  assert.equal(t.orders, 1);
  assert.equal(t.avgTicket, 500);
  assert.equal(t.daysInRange, 1);
  const daily = computeDailyBreakdown([sale, refund]);
  assert.deepEqual(daily.map(d => [d.date, d.revenue, d.orders]), [['2026-10-10', 1000, 1], ['2026-10-12', -500, 0]]);
  assert.deepEqual(computeTopProducts([sale, refund], new Map(), { by: 'units' }).map(p => [p.unitsSold, p.revenue]), [[1, 500]]);
});

test('feria por equipo y locales por hora: la NC resta plata pero no tickets', () => {
  const f = (o) => ({ channel: 'feria', status: 'completed', team: 'Presentes', date: '2026-10-10T15:00:00.000Z', items: [], ...o });
  assert.deepEqual(feriaTeams([f({ total: 1000 }), f({ total: -200, kind: 'refund' })]).map(t => [t.revenue, t.orders]), [[800, 1]]);
  const l = (o) => ({ channel: 'local_lomas', status: 'completed', date: '2026-10-10T15:00:00.000Z', items: [], ...o });
  const rows = localesByHour([l({ total: 1000 }), l({ total: -200, kind: 'refund' })]).rows;
  assert.deepEqual(rows[0].byLocal.lomas ?? Object.values(rows[0].byLocal).find(c => c.orders), { orders: 1, revenue: 800 });
});
