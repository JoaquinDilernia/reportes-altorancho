import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJourney, describeLanding, boughtLanded, channelOfSource } from '../ventasJourney.mjs';

const order = {
  id: '10', number: 500, created_at: '2026-11-16T02:45:00Z', paid_at: '2026-11-16T02:48:00Z', cancelled_at: null,
  payment_status: 'paid', total: 96000, subtotal: 120000, discount: 24000, shipping_cost_customer: 0,
  gateway_name: 'Pago Nube', storefront: 'mobile', customer_name: 'Ana', customer_email: 'ana@x.com',
  visit_landing_page: 'https://altorancho.com/productos/lampara-inalambrica-flare-76a9r/?utm_source=meta',
  visit_created_at: '2026-11-16T01:20:00Z', channel: 'meta', confidence: 'ad', campaign_name: 'C1', ad_name: 'A1',
  source_raw: { utm_source: 'meta', utm_medium: 'cpc', utm_campaign: 'c1' },
  first_channel: null, first_source: 'instagram', first_medium: 'referral',
  costEstimate: { costPerSale: 10000, level: 'ad' },
  items: [{ sku: 'L1', name: 'Lampara Inalambrica Flare', quantity: 1, price: 70000 }, { sku: 'F1', name: 'Felpudo', quantity: 2, price: 25000 }],
};

test('describeLanding reconoce producto, categoría e inicio', () => {
  assert.deepEqual(describeLanding('https://altorancho.com/productos/set-x4-servilletas-76a9r/?v=1').title, 'Set x4 servilletas');
  assert.equal(describeLanding('https://altorancho.com/').type, 'inicio');
  assert.equal(describeLanding('https://altorancho.com/deco/lamparas/').type, 'categoría');
  assert.equal(describeLanding(null), null);
});

test('boughtLanded compara el producto de entrada con lo comprado', () => {
  const landing = describeLanding(order.visit_landing_page);
  assert.equal(boughtLanded(landing, order.items), true);
  assert.equal(boughtLanded(landing, [{ name: 'Felpudo liso' }]), false);
  assert.equal(boughtLanded({ type: 'inicio' }, order.items), null);
});

test('channelOfSource traduce GA4', () => {
  assert.equal(channelOfSource('instagram', 'referral'), 'social');
  assert.equal(channelOfSource('google', 'cpc'), 'google');
  assert.equal(channelOfSource('(direct)', '(none)'), 'organic');
  assert.equal(channelOfSource(null, null), null);
});

test('buildJourney: recorrido, comportamiento y lo que dejó', () => {
  const history = [
    { id: '1', number: 100, created_at: '2025-03-01T10:00:00Z', total: 20000, payment_status: 'paid', cancelled: false, channel: 'google' },
    { id: '10', number: 500, created_at: order.created_at, total: 96000, payment_status: 'paid', channel: 'meta' },
    { id: '2', number: 150, created_at: '2025-06-01T10:00:00Z', total: 5000, payment_status: 'pending', channel: 'organic' },
    { id: '3', number: 700, created_at: '2026-11-18T10:00:00Z', total: 30000, payment_status: 'paid', channel: 'email' },
  ];
  const costBySku = new Map([['L1', 30000], ['F1', 10000]]);
  const j = buildJourney({ order, history, costBySku });
  assert.deepEqual(j.steps.map((s) => s.kind), ['first', 'history', 'visit', 'purchase', 'paid', 'after']);
  assert.equal(j.steps[0].channel, 'social');
  assert.equal(j.steps[1].count, 1);
  assert.equal(j.steps[1].firstChannel, 'google');
  assert.equal(j.customer.type, 'recurrente');
  assert.equal(j.customer.lifetimeRevenue, 146000);
  assert.equal(j.behavior.minutesToBuy, 85);
  assert.equal(j.behavior.sameSession, false);
  assert.equal(j.behavior.weekday, 'domingo'); // lunes 02:45 UTC = domingo 23:45 en Argentina
  assert.equal(j.behavior.hour, 23);
  assert.equal(j.behavior.discountPct, 20);
  assert.equal(j.behavior.landedOnBought, true);
  assert.equal(j.economics.grossProfit, 96000 - 50000);
  assert.equal(j.economics.net, 46000 - 10000);
  assert.equal(j.economics.costCoverage, 1);
});

test('buildJourney: cliente nuevo y producto sin costo estimado con el margen del resto', () => {
  const j = buildJourney({ order: { ...order, first_source: null, first_medium: null, channel: 'organic' }, history: [], costBySku: new Map([['L1', 35000]]) });
  assert.equal(j.customer.type, 'nuevo');
  assert.equal(j.steps[0].kind, 'visit');
  assert.equal(j.economics.adCost, null);
  assert.equal(j.economics.costCoverage, 0.58);
  assert.equal(j.economics.grossProfit, 96000 - 35000 - 50000 * 0.5);
});

test('buildJourney: sin historial (falló la búsqueda) el cliente queda sin dato', () => {
  assert.equal(buildJourney({ order, history: null }).customer.type, 'sin-dato');
});
