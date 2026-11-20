import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createTestDb } from './helpers/testDb.js';
import { classifySession, parseBatch } from '../src/engine/tracking.js';
import { createTrackingRepo } from '../src/repo/tracking.js';
import { createTrackRouter } from '../src/routes/track.js';

const V = 'aaaaaaaa-1111-4111-8111-111111111111';
const sid = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;

describe('classifySession', () => {
  it('anuncios y mails por UTMs / click ids, igual que la atribución de pedidos', () => {
    expect(classifySession({ url: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc&utm_campaign=x' }).channel).toBe('meta');
    expect(classifySession({ url: 'https://altorancho.com/?gclid=abc' })).toMatchObject({ channel: 'google', click_id: 'gclid' });
    expect(classifySession({ url: 'https://altorancho.com/?epik=abc' })).toMatchObject({ channel: 'pinterest', click_id: 'epik' });
    expect(classifySession({ url: 'https://altorancho.com/?utm_source=perfit&utm_medium=email&utm_campaign=cyber' })).toMatchObject({ channel: 'email', campaign: 'cyber' });
  });
  it('sin parámetros: buscador, redes, otro sitio o directo según el referrer', () => {
    expect(classifySession({ url: 'https://altorancho.com/', referrer: 'https://www.google.com/' })).toMatchObject({ channel: 'search', source: 'google.com' });
    expect(classifySession({ url: 'https://altorancho.com/', referrer: 'https://l.instagram.com/' }).channel).toBe('social_organic');
    expect(classifySession({ url: 'https://altorancho.com/', referrer: 'https://www.pinterest.com/' }).channel).toBe('social_organic');
    expect(classifySession({ url: 'https://altorancho.com/', referrer: 'https://blogdeco.com/nota' })).toMatchObject({ channel: 'referral', source: 'blogdeco.com' });
    expect(classifySession({ url: 'https://altorancho.com/' }).channel).toBe('direct');
    // navegar dentro de la misma tienda no es "referral"
    expect(classifySession({ url: 'https://altorancho.com/x', referrer: 'https://altorancho.com/' }).channel).toBe('direct');
  });
});

describe('parseBatch', () => {
  it('descarta lo inválido y se queda solo con los campos conocidos', () => {
    expect(parseBatch('no json')).toBeNull();
    expect(parseBatch({ v: 'x', s: sid(1), e: [] })).toBeNull();
    const b = parseBatch(JSON.stringify({ v: V, s: sid(1), e: [
      { t: 'session', url: 'https://altorancho.com/', dev: 'mobile', email: 'a@b.com' },
      { t: 'hack' },
      { t: 'purchase', order: '2123185567' },
      { t: 'purchase', order: 'drop table' },
    ] }));
    expect(b.events.map((e) => e.type)).toEqual(['session', 'purchase', 'purchase']);
    expect(b.events[0].email).toBeUndefined();
    expect(b.events[1].data.orderId).toBe('2123185567');
    expect(b.events[2].data.orderId).toBeNull();
  });
});

describe('recorrido de un pedido', () => {
  let db;
  let repo;
  beforeEach(async () => {
    db = await createTestDb();
    repo = createTrackingRepo(db);
    await db.query(`INSERT INTO orders (id, number, created_at, status, payment_status, total, customer_email)
      VALUES (2100000900, 1, '2026-11-15T15:00:00Z', 'open', 'paid', 100, 'Ana@x.com')`);
  });
  const at = (iso) => ({ now: new Date(iso) });

  it('junta visitas, carritos y checkouts hasta la compra', async () => {
    await repo.record(parseBatch({ v: V, s: sid(1), e: [{ t: 'session', url: 'https://altorancho.com/?utm_source=google&utm_medium=cpc', dev: 'mobile' }, { t: 'page', product: true, path: '/productos/silla/' }] }), at('2026-11-01T10:00:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(1), e: [{ t: 'add_to_cart', sku: 'S1', qty: 1, price: 50 }] }), at('2026-11-01T10:05:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(2), e: [{ t: 'session', url: 'https://altorancho.com/?epik=x', dev: 'mobile' }, { t: 'page', path: '/' }, { t: 'add_to_cart', sku: 'S2' }, { t: 'checkout', items: 2 }] }), at('2026-11-08T21:00:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(3), e: [{ t: 'session', url: 'https://altorancho.com/?utm_source=perfit&utm_medium=email', dev: 'desktop' }, { t: 'page', path: '/' }, { t: 'purchase', order: '2100000900' }] }), at('2026-11-15T15:01:00Z'));
    const j = await repo.journeyForOrder('2100000900');
    expect(j.tracked).toBe(true);
    expect(j.sessions).toBe(3);
    expect(j.addToCart).toBe(2);
    expect(j.checkouts).toBe(1);
    expect(j.productViews).toBe(1);
    expect(j.path).toEqual(['google', 'pinterest', 'email']);
    expect(j.devices.sort()).toEqual(['desktop', 'mobile']);
    expect(j.daysToBuy).toBeCloseTo(14.2, 1);
    expect(j.timeline[0].carts[0]).toMatchObject({ sku: 'S1', qty: 1, price: 50 });
    expect(j.timeline[2].purchase).toBe(true);
  });

  it('suma otro dispositivo de la misma persona (mismo mail en otro pedido)', async () => {
    const V2 = 'cccccccc-2222-4222-8222-222222222222';
    await db.query(`INSERT INTO orders (id, number, created_at, status, payment_status, total, customer_email)
      VALUES (2100000800, 0, '2026-10-01T15:00:00Z', 'open', 'paid', 100, 'ana@x.com')`);
    await repo.record(parseBatch({ v: V2, s: sid(4), e: [{ t: 'purchase', order: '2100000800' }] }), at('2026-10-01T15:01:00Z'));
    await repo.record(parseBatch({ v: V2, s: sid(5), e: [{ t: 'session', url: 'https://altorancho.com/?fbclid=1&utm_campaign=c', dev: 'mobile' }] }), at('2026-11-10T12:00:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(6), e: [{ t: 'session', url: 'https://altorancho.com/', dev: 'desktop' }, { t: 'purchase', order: '2100000900' }] }), at('2026-11-15T15:01:00Z'));
    const j = await repo.journeyForOrder('2100000900');
    expect(j.visitors).toBe(2);
    // desde la compra anterior: la visita del pedido 800 no entra
    expect(j.path).toEqual(['meta', 'direct']);
  });

  it('dos compras en la misma visita: cada una ve solo su carrito', async () => {
    await db.query(`INSERT INTO orders (id, number, created_at, status, payment_status, total, customer_email)
      VALUES (2100000901, 2, '2026-11-15T15:27:00Z', 'open', 'paid', 100, 'ana@x.com')`);
    await repo.record(parseBatch({ v: V, s: sid(8), e: [{ t: 'session', url: 'https://altorancho.com/', dev: 'desktop' }, { t: 'add_to_cart', sku: 'GIFT', name: 'Gift 1' }] }), at('2026-11-15T14:55:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(8), e: [{ t: 'purchase', order: '2100000900' }] }), at('2026-11-15T15:00:30Z'));
    await repo.record(parseBatch({ v: V, s: sid(8), e: [{ t: 'add_to_cart', sku: 'GIFT', name: 'Gift 2' }] }), at('2026-11-15T15:20:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(8), e: [{ t: 'purchase', order: '2100000901' }] }), at('2026-11-15T15:27:30Z'));
    const first = await repo.journeyForOrder('2100000900');
    expect(first.addToCart).toBe(1);
    expect(first.timeline[0].carts.map((c) => c.name)).toEqual(['Gift 1']);
    const second = await repo.journeyForOrder('2100000901');
    expect(second.addToCart).toBe(1);
    expect(second.sessions).toBe(1);
    expect(second.timeline[0].carts.map((c) => c.name)).toEqual(['Gift 2']);
  });

  it('resumen por canal: visitas, carritos, compras y participación', async () => {
    await repo.record(parseBatch({ v: V, s: sid(1), e: [{ t: 'session', url: 'https://altorancho.com/?utm_source=google&utm_medium=cpc' }, { t: 'page', product: true }, { t: 'add_to_cart', sku: 'A' }] }), at('2026-11-14T10:00:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(2), e: [{ t: 'session', url: 'https://altorancho.com/?utm_source=meta&utm_medium=cpc' }, { t: 'page' }, { t: 'page' }, { t: 'purchase', order: '2100000900' }] }), at('2026-11-15T15:01:00Z'));
    await repo.record(parseBatch({ v: 'dddddddd-3333-4333-8333-333333333333', s: sid(3), e: [{ t: 'session', url: 'https://altorancho.com/' }, { t: 'page' }] }), at('2026-11-15T16:00:00Z'));
    const r = await repo.channelSummary(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    const g = r.channels.find((c) => c.channel === 'google');
    const m = r.channels.find((c) => c.channel === 'meta');
    expect(g).toMatchObject({ visits: 1, productViews: 1, adds: 1, sessionsWithCart: 1, orders: 0, assistedOrders: 1, assistedRevenue: 100 });
    expect(m).toMatchObject({ visits: 1, pageviews: 2, orders: 1, revenue: 100, assistedOrders: 1 });
    expect(r.channels.find((c) => c.channel === 'direct')).toMatchObject({ visits: 1, bounces: 1 });
    expect(r.total).toMatchObject({ visits: 3, orders: 1, revenue: 100, adds: 1 });
  });

  it('insights: embudo, productos, búsquedas, recorridos y checkouts abandonados', async () => {
    await db.query(`INSERT INTO order_items (order_id, product_id, sku, name, quantity, price) VALUES (2100000900, 77, 'S1', 'Silla', 2, 50)`);
    await db.query(`INSERT INTO tn_checkouts (id, created_at, contact_email, total, items, products, channel)
      VALUES (1, '2026-11-14T11:00:00Z', 'ana@x.com', 100, 2, '[{"product_id":77,"name":"Silla","quantity":2,"price":50}]', 'google'),
             (2, '2026-11-14T12:00:00Z', 'otro@x.com', 900000, 1, '[{"product_id":5,"name":"Mesa","quantity":1,"price":900000}]', 'meta')`);
    await repo.record(parseBatch({ v: V, s: sid(1), e: [{ t: 'session', url: 'https://altorancho.com/productos/silla/?utm_source=google&utm_medium=cpc', dev: 'mobile' }, { t: 'page', product: true }, { t: 'product', pid: '77', name: 'Silla' }, { t: 'search', q: 'Mesa Roble' }, { t: 'add_to_cart', pid: 77, name: 'Silla' }] }), at('2026-11-14T10:00:00Z'));
    await repo.record(parseBatch({ v: V, s: sid(2), e: [{ t: 'session', url: 'https://altorancho.com/?utm_source=perfit&utm_medium=email', dev: 'mobile' }, { t: 'page' }, { t: 'product', pid: 77, name: 'Silla' }, { t: 'purchase', order: '2100000900' }] }), at('2026-11-15T15:01:00Z'));
    const r = await repo.insights(new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(r.funnel.find((f) => f.channel === 'google')).toMatchObject({ visits: 1, with_product: 1 });
    expect(r.landings.find((l) => l.path === '/productos/silla')).toMatchObject({ visits: 1, withCart: 1 });
    expect(r.devices[0]).toMatchObject({ device: 'mobile', visits: 2, orders: 1 });
    expect(r.products[0]).toMatchObject({ productId: 77, views: 2, people: 1, adds: 1, orders: 1, units: 2 });
    expect(r.searches[0]).toMatchObject({ q: 'mesa roble', searches: 1, withCart: 1 });
    expect(r.journeys.orders).toBe(1);
    expect(r.journeys.paths[0]).toMatchObject({ first: 'google', last: 'email', orders: 1 });
    expect(r.journeys.visits['2 a 3 visitas']).toBe(1);
    expect(r.checkouts).toMatchObject({ abandoned: 2, recovered: 1 });
    const j = await repo.journeyForOrder('2100000900');
    expect(j.abandonedCheckouts).toHaveLength(1);
    expect(j.timeline[0].products).toEqual(['Silla']);
    expect(j.timeline[0].searches).toEqual(['mesa roble']);
    const al = await repo.alerts(new Date('2026-11-15T13:00:00Z'));
    expect(al.alerts.find((a) => a.kind === 'checkout')).toMatchObject({ total: 900000 });
  });

  it('links de vendedores son su propio canal', () => {
    expect(classifySession({ url: 'https://altorancho.com/productos/x/?utm_source=vendedor&utm_medium=whatsapp&utm_campaign=lucia' })).toMatchObject({ channel: 'vendedor', campaign: 'lucia' });
  });

  it('sin visitas registradas lo dice', async () => {
    expect((await repo.journeyForOrder('2100000900')).tracked).toBe(false);
  });

  it('ruta pública: acepta text/plain de sendBeacon y sirve el script', async () => {
    const app = express();
    app.use(createTrackRouter({ repo, log: { error() {} } }));
    const js = await request(app).get('/t.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    const ok = await request(app).post('/t/c').set('Content-Type', 'text/plain').send(JSON.stringify({ v: V, s: sid(7), e: [{ t: 'session', url: 'https://altorancho.com/' }] }));
    expect(ok.status).toBe(204);
    expect((await request(app).post('/t/c').set('Content-Type', 'text/plain').send('basura')).status).toBe(400);
    const { rows } = await db.query('SELECT channel FROM track_sessions WHERE id = $1', [sid(7)]);
    expect(rows[0].channel).toBe('direct');
  });
});

describe('visitas desde WhatsApp', () => {
  it('UTMs del bot o referrer de WhatsApp', () => {
    expect(classifySession({ url: 'https://altorancho.com/productos/x/?utm_source=whatsapp&utm_medium=bot&utm_campaign=producto_bot' })).toMatchObject({ channel: 'whatsapp', campaign: 'producto_bot' });
    expect(classifySession({ url: 'https://altorancho.com/', referrer: 'https://web.whatsapp.com/' }).channel).toBe('whatsapp');
  });
});

it('una visita que llega desde ChatGPT es canal IA', () => {
  expect(classifySession({ url: 'https://altorancho.com/productos/x/', referrer: 'https://chatgpt.com/' }).channel).toBe('ai');
});
