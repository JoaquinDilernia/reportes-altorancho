import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageContentType, createImageStore } from '../feriaImages.mjs';

const jpeg = Buffer.from('ffd8ffe000104a46', 'hex');
const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('imageContentType reconoce JPG, PNG, WEBP y GIF por los primeros bytes', () => {
  assert.equal(imageContentType(jpeg), 'image/jpeg');
  assert.equal(imageContentType(png), 'image/png');
  assert.equal(imageContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageContentType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageContentType(Buffer.from('hola')), null);
});

test('createImageStore: trae de a lotes, recuerda también los que no tienen foto', async () => {
  const calls = [];
  const store = createImageStore(async (skus) => {
    calls.push(skus);
    return new Map([['A', jpeg]]);
  });
  await store.prefetch(['a', 'B']);
  assert.deepEqual(calls, [['A', 'B']]);
  assert.deepEqual(await store.get('A'), { data: jpeg, contentType: 'image/jpeg' });
  assert.equal(await store.get('b'), null);
  assert.equal(calls.length, 1, 'no vuelve a pedir lo que ya sabe');
});

test('createImageStore: dos pedidos a la vez del mismo SKU hacen una sola consulta', async () => {
  let count = 0;
  const store = createImageStore(async () => { count += 1; return new Map([['A', png]]); });
  const [a, b] = await Promise.all([store.get('A'), store.get('A')]);
  assert.equal(count, 1);
  assert.equal(a.contentType, 'image/png');
  assert.equal(b.contentType, 'image/png');
});

test('createImageStore: con el límite lleno descarta la más vieja', async () => {
  let count = 0;
  const store = createImageStore(async (skus) => { count += 1; return new Map(skus.map((s) => [s, jpeg])); }, { max: 2 });
  await store.prefetch(['A', 'B', 'C']);
  assert.equal(count, 1);
  await store.get('C');
  assert.equal(count, 1);
  await store.get('A');
  assert.equal(count, 2, 'A se había descartado y se vuelve a pedir');
});

test('createImageStore: si Odoo falla no guarda nada (se reintenta la próxima)', async () => {
  let fail = true;
  const store = createImageStore(async () => { if (fail) throw new Error('Odoo caído'); return new Map([['A', jpeg]]); });
  await assert.rejects(store.get('A'), /Odoo caído/);
  fail = false;
  assert.equal((await store.get('A')).contentType, 'image/jpeg');
});
