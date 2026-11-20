import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignRow, automationDelta, fetchCampaigns } from '../perfit.mjs';

test('campaignRow: métricas y si los links llevan UTMs', () => {
  const r = campaignRow({ id: 767, name: 'Beige', launchDate: '2026-11-16T21:00:00Z', recipients: 15940, options: { GOOGLE_ANALYTICS: '0' },
    metrics: { sent: 15937, opened: 11933, clicked: 178, conversions: 15, conversionsAmount: 2843871.33 } });
  assert.deepEqual(r, { id: 767, name: 'Beige', launchedAt: '2026-11-16T21:00:00Z', recipients: 15940, sent: 15937, opened: 11933, clicked: 178, conversions: 15, conversionsAmount: 2843871.33, utms: false });
  assert.equal(campaignRow({ id: 1, metrics: {} }).utms, null);
});

test('automationDelta: resta dos fotos; las nuevas quedan sin dato', () => {
  const before = [{ id: 'a', name: 'Carrito', stats: { triggered: 100, completed: 50, converted: 10, converted_amount: 1000 } }];
  const after = [
    { id: 'a', name: 'Carrito', enabled: true, stats: { triggered: 130, completed: 60, converted: 12, converted_amount: 1500 } },
    { id: 'b', name: 'Nueva', enabled: true, stats: { triggered: 5, completed: 1, converted: 0, converted_amount: 0 } },
  ];
  const d = automationDelta(before, after);
  assert.deepEqual(d[0], { id: 'a', name: 'Carrito', enabled: true, trigger: undefined, triggered: 30, completed: 10, converted: 2, converted_amount: 500 });
  assert.equal(d[1].converted, null);
});

test('fetchCampaigns: corta al pasar el inicio del rango y pide el detalle', async () => {
  process.env.PERFIT_API_KEY = 'acct-x';
  const calls = [];
  const list = { data: [
    { id: 3, state: 'SENT', launchDate: '2026-11-18T12:00:00Z', metrics: {} },
    { id: 2, state: 'SENT', launchDate: '2026-11-10T12:00:00Z', metrics: {} },
    { id: 1, state: 'SENT', launchDate: '2026-10-30T12:00:00Z', metrics: {} },
  ], paging: { next: 'x' } };
  const fetchFn = async (url) => {
    calls.push(url);
    const body = url.includes('/campaigns?') ? list : { data: { options: { GOOGLE_ANALYTICS: '1' } } };
    return { ok: true, json: async () => body };
  };
  const r = await fetchCampaigns('2026-11-01', '2026-11-30', { fetchFn });
  assert.deepEqual(r.map((c) => [c.id, c.utms]), [[3, true], [2, true]]);
  assert.equal(calls.filter((u) => u.includes('/campaigns?')).length, 1);
  assert.ok(calls[0].startsWith('https://api.myperfit.com/v2/acct/'));
  delete process.env.PERFIT_API_KEY;
});
