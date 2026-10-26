import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery, searchPurchases, resolvePurchaseLine, getPurchase } from '../posReturnsService.mjs';

test('classifyQuery: documento o referencia', () => {
  assert.deepEqual(classifyQuery('30.123.456'), { doc: '30123456' });
  assert.deepEqual(classifyQuery('20-12345678-9'), { doc: '20123456789' });
  assert.deepEqual(classifyQuery('LL-0042'), { ref: 'LL-0042' });
  assert.deepEqual(classifyQuery('Alcorta/2301'), { ref: 'Alcorta/2301' });
  assert.deepEqual(classifyQuery('TN2095995525'), { ref: 'TN2095995525' });
  assert.deepEqual(classifyQuery('2095995525'), { ref: '2095995525' });
  assert.throws(() => classifyQuery('ab'), /Escribí el DNI\/CUIT o el número/);
});

test('searchPurchases: junta los tres orígenes; si uno falla, sigue con el resto', async () => {
  const deps = {
    searchApp: async () => [{ source: 'app', purchaseId: 'o1', label: 'LL-0042', date: '2026-10-10', partnerName: 'Ana', total: 100, invoiceName: null }],
    searchTpv: async () => { throw new Error('Odoo caído'); },
    searchWeb: async () => [{ source: 'web', purchaseId: '63677', label: 'TN1', date: '2026-10-12', partnerName: 'Ana', total: 50, invoiceName: null }],
  };
  const r = await searchPurchases('30123456', { sinceISO: '2025-10-16' }, deps);
  assert.deepEqual(r.purchases.map((p) => p.label), ['TN1', 'LL-0042']);
  assert.deepEqual(r.errors, ['TPV: Odoo caído']);
});

test('resolvePurchaseLine: toma la línea de la compra leída en el servidor', async () => {
  const deps = {
    getPurchase: async () => ({ lines: [{ purchaseLineId: '92250', sku: 'A', unitValue: 100 }] }),
    manualLine: async () => { throw new Error('no'); },
  };
  assert.equal((await resolvePurchaseLine({ source: 'tpv', purchaseId: '48870', purchaseLineId: '92250' }, deps)).unitValue, 100);
  await assert.rejects(resolvePurchaseLine({ source: 'tpv', purchaseId: '48870', purchaseLineId: '1' }, deps), /Esa línea no está en la compra/);
});

test('getPurchase web: valida id entero y que sea un pedido TN', async () => {
  const readSale = async ({ purchaseId }) => ({ label: purchaseId === '5' ? 'TN123' : 'S00042', lines: [{ purchaseLineId: '1' }] });
  await assert.rejects(getPurchase('web', 'abc', { readSale }), /Pedido web inválido/);
  await assert.rejects(getPurchase('web', '6', { readSale }), /Ese pedido no es de la tienda web/);
  const p = await getPurchase('web', '5', { readSale });
  assert.equal(p.lines[0].purchaseLabel, 'TN123');
});
