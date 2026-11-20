import { test } from 'node:test';
import assert from 'node:assert/strict';

const { callKw, dryWriteLog, isReadMethod } = await import('../odoo.mjs');

test('ODOO_WRITES=dry simula escrituras y deja pasar lecturas', async () => {
  const origFetch = globalThis.fetch;
  const origEnv = process.env.ODOO_WRITES;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { headers: { get: () => null }, json: async () => ({ result: [] }) };
  };
  process.env.ODOO_WRITES = 'dry';
  try {
    const before = dryWriteLog().length;
    const ids = await callKw('sale.order', 'create', [[{ a: 1 }, { b: 2 }]]);
    assert.equal(ids.length, 2);
    assert.ok(ids.every(i => i < 0));
    assert.notEqual(ids[0], ids[1]);
    const single = await callKw('sale.order', 'create', [{ a: 1 }]);
    assert.ok(single < 0);
    const r = await callKw('stock.picking', 'button_validate', [[5]]);
    assert.equal(r.dryRun, true);
    assert.ok(r.res_id < 0);
    assert.equal(calls, 0);
    await callKw('sale.order', 'search_read', [[]]);
    assert.equal(calls, 1);
    assert.equal(dryWriteLog().length - before, 3);
    assert.ok(isReadMethod('search_read'));
    assert.ok(!isReadMethod('write'));
  } finally {
    globalThis.fetch = origFetch;
    if (origEnv === undefined) delete process.env.ODOO_WRITES; else process.env.ODOO_WRITES = origEnv;
  }
});
