import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReturnSteps, runReturnSteps, confirmReturnOrder, transferReasonOf } from '../posReturnsConfirm.mjs';
import { DEFAULT_LOCALES, DEFAULT_SETTINGS } from '../posConfig.mjs';

const ctx = { locale: DEFAULT_LOCALES[0], locales: DEFAULT_LOCALES, settings: DEFAULT_SETTINGS, methodsById: new Map() };
const rl = (over = {}) => ({
  rlId: 'R1', source: 'tpv', purchaseId: '48870', purchaseLineId: '92250', productId: 70417, sku: 'BCC104TR', qty: 1, qtyBought: 1,
  unitValue: 4990, lots: [], moveIds: [612602], invoiceId: 368292, invoiceName: 'FA-B 1', destinationId: 'exhibicion', ...over,
});
const order = (over = {}) => ({
  id: 'o1', number: 'LL-0042', localId: 'LL', lines: [], returnLines: [rl()], returnSteps: {},
  customer: { docNumber: '30123456', name: 'Ana', odooPartnerId: 91779 }, refund: { cashBack: [], credit: 4990 }, ...over,
});

function fakeDeps(over = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push([name, ...structuredClone(args)]);
    return typeof result === 'function' ? result(...args) : result;
  };
  let nextPicking = 777;
  let nextNc = 368705;
  const deps = {
    readMoves: rec('readMoves', (ids) => ids.map((mid) => ({ id: mid, product_id: [70417, 'x'], quantity_done: 1, product_uom: [1, 'u'], picking_id: [192311, 'LL/OUT/00260'] }))),
    returnedQtyByMove: rec('returned', new Map()),
    findPickingByOrigin: rec('findPicking', null),
    createReturnPicking: rec('createReturn', () => nextPicking++),
    createManualReturn: rec('createManual', () => nextPicking++),
    validatePicking: rec('validate', (pid) => ({ id: pid, name: `LL/RET/${pid}`, state: 'done' })),
    createInternalTransfer: rec('transfer', { id: 900, name: 'LL/INT/1', state: 'assigned' }),
    latestLotFor: rec('latestLot', null),
    findPartnerId: rec('partner', 91779),
    findCreditNoteByRef: rec('findNc', null),
    createCreditNoteFromInvoice: rec('createNc', () => nextNc++),
    createStandaloneCreditNote: rec('createNcManual', () => nextNc++),
    trimCreditNote: rec('trimNc'),
    readCreditNoteState: rec('readNc', (ncId) => ({ id: ncId, name: '/', state: 'draft' })),
    postCreditNote: rec('postNc', (ncId) => ({ id: ncId, name: `NC-B ${ncId}`, state: 'posted' })),
    saveReturnSteps: rec('saveSteps'),
    invoicingEnabled: () => true,
    ...over,
  };
  return { deps, calls };
}
const named = (calls, name) => calls.filter((c) => c[0] === name);

test('planReturnSteps: agrupa por remito original y destino; sin ticket por destino; traslados', () => {
  const o = order({ returnLines: [rl(), rl({ rlId: 'R2', source: 'manual', purchaseId: null, moveIds: [], destinationId: 'rolon' })] });
  const movesById = new Map([[612602, { id: 612602, product_id: [70417, 'x'], quantity_done: 1, product_uom: [1, 'u'], picking_id: [192311, 'x'] }]]);
  const plan = planReturnSteps(o, movesById, new Map(), ctx);
  assert.deepEqual(plan.pickings.map((p) => p.key), ['pick:tpv:48870:192311:exhibicion']);
  assert.deepEqual(plan.manuals.map((p) => [p.key, p.locationId]), [['manual:rolon', 8]]);
  assert.deepEqual(plan.transfers.map((t) => [t.key, t.fromLocationId, t.toLocationId, t.reason]), [['transfer:rolon', 8, 174, 'reubicacion']]);
});

test('transferReasonOf: "Fallas" si alguna línea vuelve por falla; si no, "Reubicación"', () => {
  assert.equal(transferReasonOf([{ reason: 'Talle o medida' }, { reason: 'Falla' }]), 'fallas');
  assert.equal(transferReasonOf([{ reason: 'No le gustó' }]), 'reubicacion');
  assert.equal(transferReasonOf([{}]), 'reubicacion');
});

test('runReturnSteps: devolución de remito → validada → NC parcial publicada; guarda cada paso', async () => {
  const { deps, calls } = fakeDeps();
  const steps = await runReturnSteps(order(), ctx, deps);
  assert.equal(steps.pickings['pick:tpv:48870:192311:exhibicion'].state, 'done');
  assert.equal(steps.creditNotes['nc:368292'].state, 'posted');
  const create = named(calls, 'createReturn')[0][1];
  assert.equal(create.locationId, 324);
  assert.ok(!('pickingTypeId' in create));
  assert.equal(create.origin, 'LL-0042 · pick:tpv:48870:192311:exhibicion');
  assert.deepEqual(named(calls, 'createNc')[0][1].items, [{ productId: 70417, qty: 1 }]);
  assert.equal(named(calls, 'createNc')[0][1].journalId, 32);
  assert.ok(named(calls, 'saveSteps').length >= 3);
});

test('runReturnSteps: reintento después de una falla en la NC no crea otro remito', async () => {
  const previous = { pickings: { 'pick:tpv:48870:192311:exhibicion': { id: 777, name: 'LL/RET/777', state: 'done' } }, transfers: {}, creditNotes: {} };
  const { deps, calls } = fakeDeps();
  const steps = await runReturnSteps(order({ returnSteps: previous }), ctx, deps);
  assert.equal(named(calls, 'createReturn').length, 0);
  assert.equal(named(calls, 'validate').length, 0);
  assert.equal(steps.creditNotes['nc:368292'].state, 'posted');
});

test('runReturnSteps: NC creada pero sin publicar → solo se publica', async () => {
  const previous = {
    pickings: { 'pick:tpv:48870:192311:exhibicion': { id: 777, name: 'x', state: 'done' } }, transfers: {},
    creditNotes: { 'nc:368292': { id: 368705, name: '/', state: 'draft' } },
  };
  const { deps, calls } = fakeDeps();
  await runReturnSteps(order({ returnSteps: previous }), ctx, deps);
  assert.equal(named(calls, 'createNc').length, 0);
  assert.deepEqual(named(calls, 'postNc').map((c) => c[1]), [368705]);
});

test('runReturnSteps: la respuesta se perdió y el remito ya existe en Odoo → se adopta', async () => {
  const { deps, calls } = fakeDeps({ findPickingByOrigin: async () => ({ id: 555, name: 'LL/RET/555', state: 'assigned' }) });
  const steps = await runReturnSteps(order(), ctx, deps);
  assert.equal(named(calls, 'createReturn').length, 0);
  assert.equal(steps.pickings['pick:tpv:48870:192311:exhibicion'].id, 555);
});

test('runReturnSteps: si ya se devolvió en otra operación, frena antes de crear nada', async () => {
  const { deps, calls } = fakeDeps({ returnedQtyByMove: async () => new Map([[612602, 1]]) });
  await assert.rejects(runReturnSteps(order(), ctx, deps), /ya se devolvió/);
  assert.equal(named(calls, 'createReturn').length, 0);
});

test('runReturnSteps: con facturación apagada no crea NC y lo deja marcado', async () => {
  const { deps, calls } = fakeDeps({ invoicingEnabled: () => false });
  const steps = await runReturnSteps(order(), ctx, deps);
  assert.equal(named(calls, 'createNc').length, 0);
  assert.equal(steps.creditNotesSkipped, true);
});

test('runReturnSteps: sin ticket → ingreso suelto + NC suelta con precio de lista', async () => {
  const manual = rl({ source: 'manual', purchaseId: null, purchaseLineId: null, moveIds: [], invoiceId: null, destinationId: 'stock' });
  const { deps, calls } = fakeDeps();
  await runReturnSteps(order({ returnLines: [manual] }), ctx, deps);
  assert.equal(named(calls, 'createManual')[0][1].locationId, 8);
  assert.deepEqual(named(calls, 'createNcManual')[0][1].items, [{ productId: 70417, qty: 1, unitValue: 4990 }]);
});

test('confirmReturnOrder: devolución sola → pasos de Odoo y confirmada sin pedido nuevo', async () => {
  const { deps, calls } = fakeDeps({
    markOrderConfirmed: async (...args) => { calls.push(['markConfirmed', ...args]); },
    clearPostConfirmPending: async () => {},
    getOrder: async () => ({ id: 'o1', status: 'confirmado' }),
    confirmPosOrder: async () => { throw new Error('no debería'); },
  });
  const result = await confirmReturnOrder(order(), 'Caja LL', ctx, deps);
  assert.equal(result.status, 'confirmado');
  assert.deepEqual(named(calls, 'markConfirmed')[0][2], { odooOrders: [], user: 'Caja LL' });
});

test('confirmReturnOrder: cambio → después de los pasos sigue con el flujo de venta', async () => {
  const { deps, calls } = fakeDeps({
    confirmPosOrder: async (o) => { calls.push(['confirmPos', o.returnSteps]); return { id: 'o1', status: 'confirmado' }; },
  });
  const cambio = order({ lines: [{ lineId: 'L1', status: 'activo', qty: 1, basePrice: 9990, origin: 'stock', delivery: 'ahora' }] });
  await confirmReturnOrder(cambio, 'Caja LL', ctx, deps);
  assert.ok(named(calls, 'confirmPos')[0][1].creditNotes['nc:368292']);
});

test('runReturnSteps: el reintento usa el plan guardado y no vuelve a repartir entre remitos', async () => {
  const twoMoves = (ids) => ids.map((mid) => ({
    id: mid, product_id: [70417, 'x'], quantity_done: 1, product_uom: [1, 'u'],
    picking_id: mid === 612602 ? [192311, 'LL/OUT/00260'] : [192400, 'LL/OUT/00270'],
  }));
  const line = rl({ moveIds: [612602, 612603] });
  const first = fakeDeps({
    readMoves: async (ids) => twoMoves(ids),
    returnedQtyByMove: async () => new Map([[612602, 1]]), // devolución anterior ya hecha sobre el primer remito
    validatePicking: async () => { throw new Error('Odoo caído'); },
  });
  await assert.rejects(runReturnSteps(order({ returnLines: [line] }), ctx, first.deps), /Odoo caído/);
  const saved = named(first.calls, 'saveSteps').at(-1)[2];
  assert.equal(saved.pickings['pick:tpv:48870:192400:exhibicion'].id, 777);
  assert.deepEqual(named(first.calls, 'createReturn')[0][1].items.map((i) => i.moveId), [612603]);

  // Reintento: aunque ahora Odoo diga otra cosa, no se vuelve a planificar.
  const retry = fakeDeps({ readMoves: async (ids) => twoMoves(ids), returnedQtyByMove: async () => new Map() });
  const steps = await runReturnSteps(order({ returnLines: [line], returnSteps: saved }), ctx, retry.deps);
  assert.equal(named(retry.calls, 'createReturn').length, 0);
  assert.equal(named(retry.calls, 'findPicking').length, 0);
  assert.deepEqual(named(retry.calls, 'validate').map((c) => c[1]), [777]);
  assert.equal(steps.pickings['pick:tpv:48870:192400:exhibicion'].state, 'done');
  assert.equal(Object.keys(steps.pickings).length, 1);
});

test('runReturnSteps: el plan se guarda antes de crear nada en Odoo', async () => {
  const { deps, calls } = fakeDeps();
  await runReturnSteps(order(), ctx, deps);
  const firstSave = calls.findIndex((c) => c[0] === 'saveSteps');
  const firstCreate = calls.findIndex((c) => c[0] === 'createReturn');
  assert.ok(firstSave >= 0 && firstSave < firstCreate);
  assert.deepEqual(calls[firstSave][2].plan.pickings.map((p) => p.key), ['pick:tpv:48870:192311:exhibicion']);
});

test('runReturnSteps: una NC en borrador adoptada se recorta antes de publicarla', async () => {
  const previous = { pickings: { 'pick:tpv:48870:192311:exhibicion': { id: 777, name: 'x', state: 'done' } }, transfers: {}, creditNotes: {} };
  const { deps, calls } = fakeDeps({ findCreditNoteByRef: async (ref) => { calls.push(['findNc', ref]); return { id: 368705, name: '/', state: 'draft' }; } });
  await runReturnSteps(order({ returnSteps: previous }), ctx, deps);
  assert.equal(named(calls, 'createNc').length, 0);
  assert.deepEqual(named(calls, 'trimNc').map((c) => c.slice(1)), [[368705, [{ productId: 70417, qty: 1 }]]]);
  const trim = calls.findIndex((c) => c[0] === 'trimNc');
  const post = calls.findIndex((c) => c[0] === 'postNc');
  assert.ok(trim < post);
  assert.equal(named(calls, 'findNc')[0][1], 'LL-0042 devolución nc:368292 ·');
});

test('runReturnSteps: la referencia de la NC termina con delimitador (create y find iguales)', async () => {
  const previous = { pickings: { 'pick:tpv:48870:192311:exhibicion': { id: 777, name: 'x', state: 'done' } }, transfers: {}, creditNotes: {} };
  const { deps, calls } = fakeDeps();
  await runReturnSteps(order({ returnSteps: previous }), ctx, deps);
  assert.equal(named(calls, 'findNc')[0][1], 'LL-0042 devolución nc:368292 ·');
  assert.equal(named(calls, 'createNc')[0][1].reason, 'LL-0042 devolución nc:368292 ·');
  assert.equal(named(calls, 'trimNc').length, 0); // recién creada: createCreditNoteFromInvoice ya la recorta
});

test('runPostConfirmSteps: si falla la aplicación de NC queda aviso y se cierra el pendiente', async () => {
  const { runPostConfirmSteps } = await import('../posConfirm.mjs');
  const calls = [];
  await runPostConfirmSteps(
    { id: 'o1', lines: [], odooOrders: [], invoiceId: 400, invoiceName: 'FA-B 2', returnSteps: {} }, 'Caja LL', ctx,
    {
      creditNoteIdsOf: async () => { throw new Error('Firestore caído'); },
      setOrderWarning: async (id, w) => { calls.push(['warning', w]); },
      clearPostConfirmPending: async () => { calls.push(['clear']); },
    },
  );
  assert.match(named(calls, 'warning')[0][1], /No se pudieron aplicar las notas de crédito.*Firestore caído/);
  assert.equal(named(calls, 'clear').length, 1);
});

test('runReturnSteps: NC guardada en borrador que en Odoo ya está publicada → no se recorta ni publica, queda publicada', async () => {
  const previous = {
    pickings: { 'pick:tpv:48870:192311:exhibicion': { id: 777, name: 'x', state: 'done' } }, transfers: {},
    creditNotes: { 'nc:368292': { id: 368705, name: '/', state: 'draft' } },
  };
  const { deps, calls } = fakeDeps({ readCreditNoteState: async (ncId) => { calls.push(['readNc', ncId]); return { id: ncId, name: 'NC-B 77', state: 'posted' }; } });
  const steps = await runReturnSteps(order({ returnSteps: previous }), ctx, deps);
  assert.deepEqual(named(calls, 'readNc').map((c) => c[1]), [368705]);
  assert.equal(named(calls, 'trimNc').length, 0);
  assert.equal(named(calls, 'postNc').length, 0);
  assert.deepEqual(steps.creditNotes['nc:368292'], { id: 368705, name: 'NC-B 77', state: 'posted' });
  assert.deepEqual(named(calls, 'saveSteps').at(-1)[2].creditNotes['nc:368292'], { id: 368705, name: 'NC-B 77', state: 'posted' });
});

import { applyCreditNotesStep, saldoNcAutoApplies } from '../posReturnsConfirm.mjs';

function applyDeps(residuals) {
  const calls = [];
  const deps = {
    readMoveResiduals: async (ids) => { calls.push(['residuals', ids]); return new Map(Object.entries(residuals).map(([k, v]) => [Number(k), v])); },
    applyCreditNote: async (inv, nc) => { calls.push(['apply', inv, nc]); return true; },
    saveAppliedCreditNotes: async (id, applied) => { calls.push(['saveApplied', applied]); },
  };
  return { deps, calls };
}
const saldoOrder = (saldo) => ({
  id: 'o1', appliedCreditNoteIds: [],
  payments: [{ methodId: 'efectivo', amount: 5000 }, { methodId: 'saldo', amount: saldo }], totals: { total: 5000 + saldo },
});

test('saldoNcAutoApplies: solo si lo que concilia Odoo no pasa del saldo usado (±0,01)', () => {
  assert.equal(saldoNcAutoApplies({ ncResidual: 2000, invoiceResidual: 9000, saldoLeft: 2000 }), true);
  assert.equal(saldoNcAutoApplies({ ncResidual: 2000.01, invoiceResidual: 9000, saldoLeft: 2000 }), true);
  assert.equal(saldoNcAutoApplies({ ncResidual: 6000, invoiceResidual: 1500, saldoLeft: 2000 }), true);
  assert.equal(saldoNcAutoApplies({ ncResidual: 6000, invoiceResidual: 9000, saldoLeft: 2000 }), false);
});

test('applyCreditNotesStep: NC de saldo con lo abierto dentro del saldo usado → se aplica sola', async () => {
  const { deps, calls } = applyDeps({ 400: { id: 400, name: 'FA-B 2', residual: 7000 }, 501: { id: 501, name: 'NC-B 5', residual: 2000 } });
  const warnings = await applyCreditNotesStep(saldoOrder(2000), 400, { own: [], saldo: [501] }, deps);
  assert.deepEqual(warnings, []);
  assert.deepEqual(calls.filter((c) => c[0] === 'apply'), [['apply', 400, 501]]);
  assert.deepEqual(calls.find((c) => c[0] === 'residuals')[1], [501, 400]);
});

test('applyCreditNotesStep: NC de saldo con más abierto que el saldo usado → aviso y no se aplica', async () => {
  const { deps, calls } = applyDeps({ 400: { id: 400, name: 'FA-B 2', residual: 7000 }, 501: { id: 501, name: 'NC-B 5', residual: 6000 } });
  const warnings = await applyCreditNotesStep(saldoOrder(2000), 400, { own: [], saldo: [501] }, deps);
  assert.equal(calls.filter((c) => c[0] === 'apply').length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Aplicá en Odoo la nota de crédito NC-B 5 por \$ 2\.000 a la factura$/);
});

test('applyCreditNotesStep: las NC propias de la operación se aplican sin leer lo abierto', async () => {
  const { deps, calls } = applyDeps({});
  const warnings = await applyCreditNotesStep({ id: 'o1', appliedCreditNoteIds: [], payments: [{ methodId: 'efectivo' }], totals: { total: 1 } }, 400, { own: [368705], saldo: [] }, deps);
  assert.deepEqual(warnings, []);
  assert.deepEqual(calls.filter((c) => c[0] === 'apply'), [['apply', 400, 368705]]);
  assert.equal(calls.filter((c) => c[0] === 'residuals').length, 0);
});
