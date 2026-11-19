import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatARS, buildProduct, pickPricelists, buildDocs } from '../sync/pickPrices.mjs';

test('formatARS', () => {
  assert.equal(formatARS(99990), '$ 99.990,00');
  assert.equal(formatARS(8990), '$ 8.990,00');
});

test('buildProduct sin promo: efectivo 25% off', () => {
  const p = buildProduct('ALF001BN', 'ALFOMBRA GRANDE', 38349, 99990, null);
  assert.equal(p.Name, 'ALF001BN');
  assert.equal(p.Precio, '$ 99.990,00');
  assert.equal(p.Descuento, 'NO');
  assert.equal(p.Efecivo, '$ 74.992,50');
  assert.ok(!p.Pdesceunto && !p.Porcentaje);
  assert.equal(p.img, 'https://lett.exemax.ar/web/image/product.template/38349/image_512');
});

test('buildProduct con promo: efectivo sobre el precio promo', () => {
  const p = buildProduct('ALF001BN', 'ALFOMBRA GRANDE', 38349, 99990, 65994);
  assert.equal(p.Descuento, 'SI');
  assert.equal(p.Pdesceunto, '$ 65.994,00');
  assert.equal(p.Porcentaje, '34%');
  assert.equal(p.Efecivo, '$ 49.495,50');
});

test('buildProduct: promo igual o mayor no cuenta como descuento; sin imagen no hay img', () => {
  const p = buildProduct('X', 'X', null, 1000, 1000);
  assert.equal(p.Descuento, 'NO');
  assert.ok(!p.img);
});

test('pickPricelists elige las más nuevas y exige las dos', () => {
  const all = [
    { id: 3, name: 'Tienda Nube 2025' }, { id: 9, name: 'Tienda Nube 2026' },
    { id: 10, name: 'Tienda Nube PROMO' }, { id: 4, name: 'Tienda Nube promo vieja' }, { id: 20, name: 'Mayorista' },
  ];
  assert.deepEqual(pickPricelists(all), { tnId: 9, promoId: 10 });
  assert.throws(() => pickPricelists([{ id: 1, name: 'Tienda Nube' }]), /Promo/);
  assert.throws(() => pickPricelists([]), /Tienda Nube/);
});

test('buildDocs: saltea plantillas sin producto activo y usa la promo si hay', () => {
  const productMap = new Map([[1, { sku: 'A', name: 'a', hasImage: true }], [2, { sku: 'B', name: 'b', hasImage: false }]]);
  const { docs, skipped } = buildDocs(new Map([[1, 100], [2, 200], [3, 300]]), new Map([[1, 80]]), productMap);
  assert.equal(skipped, 1);
  assert.deepEqual(docs.map((d) => d.id), ['A', 'B']);
  assert.equal(docs[0].data.Descuento, 'SI');
  assert.ok(docs[0].data.img && !docs[1].data.img);
});

test('rutas /api/pick: sin token o con secreto equivocado → 401', async () => {
  process.env.PICK_SYNC_SECRET = 'secreto-de-prueba';
  const { default: request } = await import('supertest');
  const { app } = await import('../index.mjs');
  for (const [method, path] of [['get', '/api/pick/status'], ['post', '/api/pick/sync']]) {
    assert.equal((await request(app)[method](path)).status, 401);
    assert.equal((await request(app)[method](path).set('Authorization', 'Bearer otro-secreto-xx')).status, 401);
    assert.equal((await request(app)[method](path).set('Authorization', 'Bearer ')).status, 401);
  }
});

test('requireAuthOrSecret: acepta el secreto o el token del panel, nada más', async () => {
  const { requireAuthOrSecret, generateToken } = await import('../auth.mjs');
  process.env.PICK_SYNC_SECRET = 'secreto-de-prueba';
  const mw = requireAuthOrSecret('PICK_SYNC_SECRET');
  const run = (authorization) => {
    let passed = false; let status = 200;
    mw({ headers: authorization === undefined ? {} : { authorization } }, { status(c) { status = c; return this; }, json() {} }, () => { passed = true; });
    return passed ? 'ok' : status;
  };
  assert.equal(run('Bearer secreto-de-prueba'), 'ok');
  assert.equal(run(`Bearer ${generateToken(60)}`), 'ok');
  assert.equal(run('secreto-de-prueba'), 401);
  assert.equal(run('Bearer secreto-de-prueb'), 401);
  assert.equal(run(undefined), 401);
  process.env.PICK_SYNC_SECRET = '';
  assert.equal(run('Bearer '), 401);
});
