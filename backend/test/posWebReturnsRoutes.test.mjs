import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.POS_AUTH_SECRET = 'test-secret-pos';
const { requireBotKey, phoneMatches, identityMatches, webReturnActions, createWebReturnsRouter, jsonExceptBigBodies } = await import('../posWebReturnsRoutes.mjs');
const { saveEvidence, evidenceUrl, readEvidenceFile } = await import('../posWebReturnsEvidence.mjs');
const { buildDraftFromInput } = await import('../posWebReturnsDraft.mjs');
const { generateToken, requirePosAuth, requirePosRole } = await import('../posAuth.mjs');

// ---- requireBotKey ----
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const botReq = (key) => ({ get: (h) => (h.toLowerCase() === 'x-pos-bot-key' ? key : undefined), headers: key === undefined ? {} : { 'x-pos-bot-key': key } });

test('requireBotKey: sin POS_BOT_SECRET → 503', () => {
  const prev = process.env.POS_BOT_SECRET;
  delete process.env.POS_BOT_SECRET;
  try {
    const res = fakeRes();
    let called = false;
    requireBotKey(botReq('x'), res, () => { called = true; });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Integración con el bot no configurada/);
    assert.equal(called, false);
  } finally { if (prev !== undefined) process.env.POS_BOT_SECRET = prev; }
});

test('requireBotKey: clave errónea o ausente → 401; correcta → next', () => {
  process.env.POS_BOT_SECRET = 'secreto-bot';
  for (const key of ['otra', 'secreto-bo', undefined, '']) {
    const res = fakeRes();
    let called = false;
    requireBotKey(botReq(key), res, () => { called = true; });
    assert.equal(res.statusCode, 401, `clave ${key}`);
    assert.equal(called, false);
  }
  const res = fakeRes();
  let called = false;
  requireBotKey(botReq('secreto-bot'), res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

// ---- Evidencia ----
function fakeBucket() {
  const files = new Map();
  return {
    files,
    file(path) {
      return {
        async save(buf, opts) { files.set(path, { buf: Buffer.from(buf), opts }); },
        async download() { if (!files.has(path)) throw new Error('No such object'); return [files.get(path).buf]; },
        async getSignedUrl(o) { return [`https://signed/${path}?exp=${o.expires}&action=${o.action}`]; },
      };
    },
  };
}
const b64 = (n) => Buffer.alloc(n, 1).toString('base64');

test('saveEvidence: tipo no permitido', async () => {
  await assert.rejects(saveEvidence({ requestId: 'abc', base64: b64(10), mimetype: 'text/html', uploadedBy: 'Juan' }, fakeBucket()), /Tipo de archivo no permitido/);
});

test('saveEvidence: más de 15 MB', async () => {
  await assert.rejects(saveEvidence({ requestId: 'abc', base64: b64(16 * 1024 * 1024), mimetype: 'image/jpeg', uploadedBy: 'Juan' }, fakeBucket()), /hasta 15 MB/);
});

test('saveEvidence: vacío o id raro', async () => {
  await assert.rejects(saveEvidence({ requestId: 'abc', base64: '', mimetype: 'image/jpeg' }, fakeBucket()), /Falta el archivo/);
  await assert.rejects(saveEvidence({ requestId: '../x', base64: b64(5), mimetype: 'image/jpeg' }, fakeBucket()), /Solicitud inválida/);
});

test('saveEvidence guarda en pos-web-returns/<id>/<uuid>.<ext>; lee y firma', async () => {
  const bucket = fakeBucket();
  const saved = await saveEvidence({ requestId: 'abc', base64: `data:image/png;base64,${b64(20)}`, mimetype: 'image/png', uploadedBy: 'Juan' }, bucket);
  assert.match(saved.storagePath, /^pos-web-returns\/abc\/[0-9a-f-]{36}\.png$/);
  assert.equal(saved.kind, 'image');
  assert.equal(saved.mimetype, 'image/png');
  const stored = bucket.files.get(saved.storagePath);
  assert.equal(stored.buf.length, 20);
  assert.equal(stored.opts.contentType, 'image/png');
  const pdf = await saveEvidence({ requestId: 'abc', base64: b64(3), mimetype: 'application/pdf' }, bucket);
  assert.equal(pdf.kind, 'pdf');
  const vid = await saveEvidence({ requestId: 'abc', base64: b64(3), mimetype: 'video/mp4' }, bucket);
  assert.equal(vid.kind, 'video');
  const file = await readEvidenceFile(saved.storagePath, bucket);
  assert.equal(file.base64, b64(20));
  assert.equal(file.mimetype, 'image/png');
  assert.match(file.name, /\.png$/);
  const before = Date.now();
  const url = await evidenceUrl(saved.storagePath, bucket);
  const exp = Number(/exp=(\d+)/.exec(url)[1]);
  assert.ok(exp - before >= 3590e3 && exp - before <= 3610e3, 'vence en 1 hora');
  assert.match(url, /action=read/);
});

// ---- Identidad ----
test('teléfonos: últimos 8 dígitos', () => {
  assert.equal(phoneMatches('+54 9 11 5555-1234', '1155551234'), true);
  assert.equal(phoneMatches('11 4444 0000', '1155551234'), false);
  assert.equal(phoneMatches('', '1155551234'), false);
  assert.equal(phoneMatches('1234', '1234'), false, 'menos de 8 dígitos no alcanza');
});

test('identidad: teléfono o mail (sin importar mayúsculas)', () => {
  const customer = { phone: '+54 9 11 5555-1234', email: 'Ana@Mail.com' };
  assert.equal(identityMatches({ phone: '1155551234' }, customer), true);
  assert.equal(identityMatches({ email: ' ana@mail.COM ' }, customer), true);
  assert.equal(identityMatches({ phone: '1144440000', email: 'otra@mail.com' }, customer), false);
  assert.equal(identityMatches({}, customer), false);
  assert.equal(identityMatches({ email: '' }, { email: '' }), false);
});

// ---- buildDraftFromInput ----
const settings = { webReturns: { windowBusinessDays: 30, holidays: [], defaultDestinationByReason: { falla: 'falla', disconformidad: 'stock' } } };
const purchaseLine = { purchaseLineId: 10, productId: 5, sku: 'S1', name: 'Zapa', qtyBought: 2, qtyReturnedBefore: 0, unitValue: 100, lots: ['L1'], moveIds: [7] };
const resolved = {
  tn: { id: 999, number: '123', customer: { name: 'Ana Perez', email: 'ana@mail.com', phone: '+54 9 11 5555-1234', identification: '30111222' }, shippingAddress: 'Calle 1, CABA' },
  purchase: { source: 'web', purchaseId: 77, ref: '123', tnOrderId: 999, date: '2026-11-02T13:00:00.000Z', lines: [purchaseLine] },
  returnable: [{ ...purchaseLine, available: 2 }],
};
const input = (o = {}) => ({
  tnNumber: '123', kind: 'devolucion', reason: 'disconformidad',
  returnLines: [{ purchaseLineId: 10, qty: 1, destinationId: 'stock', unitValue: 1, moveIds: [999] }],
  logistics: { mode: 'envio_cliente' }, ...o,
});

test('buildDraftFromInput: valores del servidor, canal forzado y cliente precargado', async () => {
  let asked;
  const d = await buildDraftFromInput(input({ channel: 'whatsapp', customer: { phone: '', email: 'nuevo@mail.com', zone: 'interior' } }), {
    channel: 'manual', settings, now: new Date('2026-11-20T12:00:00Z'), resolve: async (n) => { asked = n; return resolved; },
  });
  assert.equal(asked, '123');
  assert.equal(d.channel, 'manual');
  assert.equal(d.returnLines[0].unitValue, 100);
  assert.deepEqual(d.returnLines[0].moveIds, [7]);
  assert.equal(d.returnLines[0].destinationId, 'stock');
  assert.equal(d.customer.name, 'Ana Perez');
  assert.equal(d.customer.phone, '+54 9 11 5555-1234', 'string vacío no pisa');
  assert.equal(d.customer.email, 'nuevo@mail.com', 'string con texto gana');
  assert.equal(d.customer.doc, '30111222');
  assert.equal(d.customer.address, 'Calle 1, CABA');
  assert.equal(d.customer.zone, 'interior');
  assert.deepEqual(d.purchase, { source: 'web', purchaseId: 77, ref: '123', tnOrderId: 999, date: '2026-11-02T13:00:00.000Z', late: false });
  assert.deepEqual(d.evidence, []);
});

test('buildDraftFromInput: fuera de plazo, falla sin evidencia pasa, labelPath del cliente se ignora', async () => {
  const d = await buildDraftFromInput(input({ reason: 'falla', purchase: { late: false, ref: 'trucho' }, evidence: [{ storagePath: 'x' }], logistics: { mode: 'envio_cliente', labelPath: 'x', derivedLocalId: 'LL' } }), {
    channel: 'manual', settings, now: new Date('2027-03-01T12:00:00Z'), resolve: async () => resolved,
  });
  assert.equal(d.purchase.late, true);
  assert.equal(d.purchase.ref, '123');
  assert.deepEqual(d.evidence, []);
  assert.equal(d.logistics.labelPath, null);
  assert.equal(d.logistics.derivedLocalId, null);
});

test('buildDraftFromInput: sin número de pedido', async () => {
  await assert.rejects(buildDraftFromInput(input({ tnNumber: '' }), { channel: 'manual', settings, now: new Date(), resolve: async () => resolved }), /número de pedido/);
});

test('buildDraftFromInput: la misma línea en dos filas suma contra lo disponible', async () => {
  const two = [{ purchaseLineId: 10, qty: 1, destinationId: 'stock' }, { purchaseLineId: '10', qty: 1, destinationId: 'falla' }];
  const d = await buildDraftFromInput(input({ returnLines: two }), { channel: 'manual', settings, now: new Date(), resolve: async () => resolved });
  assert.equal(d.returnLines.length, 2);
  await assert.rejects(
    buildDraftFromInput(input({ returnLines: [...two, { purchaseLineId: 10, qty: 1, destinationId: 'stock' }] }), { channel: 'manual', settings, now: new Date(), resolve: async () => resolved }),
    /Solo se puede devolver 0/,
  );
});

// ---- Acciones (deps falsas) ----
function mkDeps(over = {}) {
  const calls = [];
  const resolveCalls = [];
  let current = {
    id: 'r1', number: 'CW-000001', status: 'pendiente_aprobacion', kind: 'devolucion', reason: 'falla', channel: 'manual',
    customer: { name: 'Ana Perez', phone: '11', email: '', doc: '', address: '', zone: 'amba' },
    purchase: { source: 'web', purchaseId: 77, ref: '123', tnOrderId: 999, date: '2026-11-02T13:00:00.000Z', late: false },
    returnLines: [{ purchaseLineId: 10, productId: 5, sku: 'S1', name: 'Zapa', qty: 1, unitValue: 100, destinationId: 'falla', moveIds: [7], lots: [] }],
    newLines: [], evidence: [], logistics: { mode: 'envio_cliente', payer: 'altorancho', cost: 0, shippingCharge: 0, labelPath: null, derivedLocalId: null },
    createdAt: '2026-11-03T10:00:00.000Z', busy: null,
  };
  const deps = {
    calls,
    get current() { return current; },
    set current(v) { current = v; },
    store: {
      getWebReturn: async () => current,
      listWebReturns: async (q) => { calls.push(['list', q]); return [{ ...current, busy: { by: 'x' } }]; },
      countPending: async () => 3,
      createWebReturn: async (draft, user) => { calls.push(['create', draft, user]); return { ...draft, id: 'new', number: 'CW-000002', status: 'pendiente_aprobacion' }; },
      updateDraft: async (id, patch, user) => { calls.push(['update', id, patch, user]); return { ...current, ...patch }; },
      appendEvidence: async (id, item, user) => { calls.push(['append', id, item, user]); return { ...current, evidence: [...current.evidence, item] }; },
      setLabel: async (id, path, user) => { calls.push(['label', id, path, user]); return { ...current, logistics: { ...current.logistics, labelPath: path } }; },
    },
    service: Object.fromEntries(['approve', 'reject', 'derive', 'receive', 'refundDone', 'close'].map((k) => [k, async (...a) => { calls.push([k, ...a]); return { ...current, status: k }; }])),
    evidence: {
      saveEvidence: async (f) => { calls.push(['save', f]); return { storagePath: `pos-web-returns/${f.requestId}/u.png`, kind: f.kind ?? 'image', mimetype: f.mimetype, name: 'u.png' }; },
      evidenceUrl: async (p) => { if (p === 'roto') throw new Error('sin firma'); return `https://signed/${p}`; },
    },
    getSettings: async () => settings,
    getLocales: async () => [{ id: 'LL', name: 'Local L', secret: 'x' }],
    resolveCalls,
    resolve: async (...args) => { resolveCalls.push(args); return resolved; },
    now: () => new Date('2026-11-20T12:00:00Z'),
    ...over,
  };
  return deps;
}

test('aprobar: falla sin evidencia frena antes de llamar a approve', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  await assert.rejects(a.transition('approve', 'r1', {}, 'Juan'), /En una falla hacen falta fotos o video/);
  assert.equal(deps.calls.some((c) => c[0] === 'approve'), false);
  deps.current = { ...deps.current, evidence: [{ storagePath: 'p', kind: 'image', mimetype: 'image/png' }] };
  const r = await a.transition('approve', 'r1', {}, 'Juan');
  assert.equal(r.status, 'approve');
  assert.deepEqual(deps.calls.at(-1), ['approve', 'r1', 'Juan']);
});

test('transiciones pasan motivo, local, nota y usuario', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  await a.transition('reject', 'r1', { reason: 'No aplica' }, 'Juan');
  assert.deepEqual(deps.calls.at(-1), ['reject', 'r1', 'Juan', 'No aplica']);
  await a.transition('derive', 'r1', { localId: 'LL' }, 'Juan');
  assert.deepEqual(deps.calls.at(-1), ['derive', 'r1', 'Juan', 'LL']);
  await assert.rejects(a.transition('derive', 'r1', { localId: 'ZZ' }, 'Juan'), /local válido/);
  await a.transition('refund-done', 'r1', { note: 'transferido' }, 'Juan');
  assert.deepEqual(deps.calls.at(-1), ['refundDone', 'r1', 'Juan', 'transferido']);
  await a.transition('receive', 'r1', {}, 'Juan');
  assert.deepEqual(deps.calls.at(-1), ['receive', 'r1', 'Juan']);
  await a.transition('close', 'r1', {}, 'Juan');
  assert.deepEqual(deps.calls.at(-1), ['close', 'r1', 'Juan']);
  await assert.rejects(a.transition('borrar', 'r1', {}, 'Juan'), /Acción desconocida/);
});

test('lista: items livianos y estados separados por coma', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  const rows = await a.list({ status: 'aprobada,recibida', q: 'ana' });
  assert.deepEqual(deps.calls.at(-1), ['list', { status: ['aprobada', 'recibida'], q: 'ana' }]);
  assert.deepEqual(rows[0], {
    id: 'r1', number: 'CW-000001', status: 'pendiente_aprobacion', kind: 'devolucion', reason: 'falla',
    customer: { name: 'Ana Perez' }, purchase: { ref: '123' }, createdAt: '2026-11-03T10:00:00.000Z', late: false, busy: true,
  });
  await a.list({ status: 'aprobada' });
  assert.deepEqual(deps.calls.at(-1), ['list', { status: 'aprobada', q: '' }]);
  await assert.rejects(a.list({ status: 'inventado' }), /Estado inválido/);
  assert.deepEqual(await a.count(), { pending: 3 });
});

test('detalle: URLs firmadas (una que falla queda null), destinos y locales', async () => {
  const deps = mkDeps();
  deps.current = { ...deps.current, evidence: [{ storagePath: 'ok' }, { storagePath: 'roto' }], logistics: { ...deps.current.logistics, labelPath: 'lbl' } };
  const settingsWithDest = { webReturns: { destinations: [{ id: 'stock', label: 'Stock', locationId: 5 }, { id: 'mal', label: 'x' }] } };
  const d = await webReturnActions({ ...deps, getSettings: async () => settingsWithDest }).detail('r1');
  assert.deepEqual(d.evidence.map((e) => e.url), ['https://signed/ok', null]);
  assert.equal(d.logistics.labelUrl, 'https://signed/lbl');
  assert.deepEqual(d.destinations.map((x) => x.id), ['stock']);
  assert.deepEqual(d.locales, [{ id: 'LL', name: 'Local L' }]);
});

test('alta manual: canal manual y usuario', async () => {
  const deps = mkDeps();
  const r = await webReturnActions(deps).createManual(input({ channel: 'whatsapp' }), 'Juan');
  const [, draft, user] = deps.calls.find((c) => c[0] === 'create');
  assert.equal(draft.channel, 'manual');
  assert.equal(user, 'Juan');
  assert.equal(r.number, 'CW-000002');
});

test('PATCH: con returnLines reconstruye desde el pedido; sin ellas valida y mezcla', async () => {
  const deps = mkDeps();
  deps.current = { ...deps.current, evidence: [{ storagePath: 'p', kind: 'image', mimetype: 'image/png' }] };
  const a = webReturnActions(deps);
  await a.patch('r1', { returnLines: [{ purchaseLineId: 10, qty: 2, unitValue: 1 }], channel: 'instagram' }, 'Juan');
  let [, id, patch, user] = deps.calls.at(-1);
  assert.equal(id, 'r1');
  assert.equal(user, 'Juan');
  assert.equal(patch.returnLines[0].qty, 2);
  assert.equal(patch.returnLines[0].unitValue, 100);
  assert.equal(patch.channel, 'manual');
  assert.deepEqual(patch.evidence.map((e) => e.storagePath), ['p'], 'conserva la evidencia');
  assert.equal(patch.purchase.late, false, 'el plazo se mide a la fecha de alta');

  assert.deepEqual(deps.resolveCalls.at(-1), ['123', { excludeRequestId: 'r1' }], 'la solicitud editada no cuenta contra sí misma');

  await a.patch('r1', { reasonNote: 'roto', customer: { phone: '22' }, evidence: [], purchase: { ref: 'x' } }, 'Juan');
  [, id, patch] = deps.calls.at(-1);
  assert.equal(patch.reasonNote, 'roto');
  assert.equal(patch.customer.phone, '22');
  assert.equal(patch.customer.name, 'Ana Perez');
  assert.equal(patch.purchase.ref, '123');
  assert.deepEqual(patch.evidence.map((e) => e.storagePath), ['p']);
});

test('evidencia: guarda y agrega; no editable no sube nada', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  const r = await a.addEvidence('r1', { base64: 'AAA=', mimetype: 'image/png' }, 'bot');
  assert.deepEqual(deps.calls.find((c) => c[0] === 'save')[1], { requestId: 'r1', base64: 'AAA=', mimetype: 'image/png', uploadedBy: 'bot' });
  const [, , item, user] = deps.calls.find((c) => c[0] === 'append');
  assert.equal(item.storagePath, 'pos-web-returns/r1/u.png');
  assert.equal(user, 'bot');
  assert.equal(r.evidence.length, 1);
  deps.current = { ...deps.current, status: 'aprobada' };
  deps.calls.length = 0;
  await assert.rejects(a.addEvidence('r1', { base64: 'AAA=', mimetype: 'image/png' }, 'bot'), /no se puede editar/);
  assert.equal(deps.calls.length, 0);
});

test('etiqueta: solo aprobada, se guarda como label', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  await assert.rejects(a.setLabel('r1', { base64: 'AAA=', mimetype: 'application/pdf' }, 'Juan'), /aprobada/);
  deps.current = { ...deps.current, status: 'aprobada' };
  const r = await a.setLabel('r1', { base64: 'AAA=', mimetype: 'application/pdf' }, 'Juan');
  assert.equal(deps.calls.find((c) => c[0] === 'save')[1].kind, 'label');
  assert.deepEqual(deps.calls.at(-1), ['label', 'r1', 'pos-web-returns/r1/u.png', 'Juan']);
  assert.equal(r.logistics.labelPath, 'pos-web-returns/r1/u.png');
});

test('bot: compra con identidad válida devuelve lo mínimo; si no, 403', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  const r = await a.botPurchase({ ref: '#123', phone: '11 5555 1234' });
  assert.deepEqual(r, {
    ref: '123', date: '2026-11-02T13:00:00.000Z', late: false, customerName: 'Ana Perez',
    returnable: [{ purchaseLineId: 10, sku: 'S1', name: 'Zapa', available: 2, unitValue: 100 }],
  });
  await assert.rejects(a.botPurchase({ ref: '123', phone: '11 4444 0000' }), (err) => err.status === 403 && /No pudimos validar que el pedido sea tuyo/.test(err.message));
  assert.ok(await a.botPurchase({ ref: '123', email: 'ANA@mail.com' }));
});

test('bot: alta con canal válido, conversación e identidad; usuario bot', async () => {
  const deps = mkDeps();
  const a = webReturnActions(deps);
  const body = input({ channel: 'whatsapp', botConversationId: 'conv-1', phone: '1155551234' });
  const r = await a.botCreate(body);
  assert.deepEqual(r, { id: 'new', number: 'CW-000002', status: 'pendiente_aprobacion' });
  const [, draft, user] = deps.calls.find((c) => c[0] === 'create');
  assert.equal(draft.channel, 'whatsapp');
  assert.equal(draft.botConversationId, 'conv-1');
  assert.equal(user, 'bot');
  await assert.rejects(a.botCreate({ ...body, channel: 'manual' }), /Canal inválido/);
  await assert.rejects(a.botCreate({ ...body, botConversationId: '' }), /conversación/);
  await assert.rejects(a.botCreate({ ...body, phone: '1144440000' }), (err) => err.status === 403);
});

test('bot: estado mínimo', async () => {
  const deps = mkDeps();
  deps.current = { ...deps.current, status: 'rechazada', rejectReason: 'Fuera de política' };
  assert.deepEqual(await webReturnActions(deps).botStatus('r1'), { number: 'CW-000001', status: 'rechazada', rejectReason: 'Fuera de política' });
});

// ---- Router montado ----
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/pos', createWebReturnsRouter({ admins: [requirePosAuth, requirePosRole('admin')], deps: mkDeps() }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/pos`;
  try { await fn(base); } finally { server.close(); }
}

test('router: guards de admin y de bot, rutas fijas antes que :id', async () => {
  process.env.POS_BOT_SECRET = 'secreto-bot';
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/admin/web-returns`)).status, 401);
    const vend = generateToken({ id: 'v1', role: 'vendedor', localId: 'LL', name: 'Ana' });
    assert.equal((await fetch(`${base}/admin/web-returns`, { headers: { Authorization: `Bearer ${vend}` } })).status, 403);
    const token = generateToken({ id: 'a1', role: 'admin', name: 'Admin' });
    const headers = { Authorization: `Bearer ${token}` };
    assert.deepEqual(await (await fetch(`${base}/admin/web-returns/count`, { headers })).json(), { pending: 3 });
    assert.equal((await fetch(`${base}/admin/web-returns/a.b`, { headers })).status, 400);
    assert.equal((await (await fetch(`${base}/admin/web-returns/r1`, { headers })).json()).number, 'CW-000001');
    assert.equal((await fetch(`${base}/bot/web-returns/r1`)).status, 401);
    assert.equal((await fetch(`${base}/bot/web-returns/r1`, { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'el token de admin no sirve para el bot');
    const bot = await fetch(`${base}/bot/web-returns/r1`, { headers: { 'x-pos-bot-key': 'secreto-bot' } });
    assert.deepEqual(await bot.json(), { number: 'CW-000001', status: 'pendiente_aprobacion', rejectReason: null });
    const forbidden = await fetch(`${base}/bot/web-returns/purchase?ref=123&phone=1144440000`, { headers: { 'x-pos-bot-key': 'secreto-bot' } });
    assert.equal(forbidden.status, 403);
  });
});

test('index: evidencia y etiqueta sin auth → 401 sin parsear el cuerpo; el resto sigue en el límite global', async () => {
  const { app } = await import('../index.mjs');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/pos`;
  try {
    const big = JSON.stringify({ base64: 'A'.repeat(2 * 1024 * 1024), mimetype: 'image/png' });
    // JSON roto y grande: si alguien lo parseara antes del guard saldría 400 o 413.
    const broken = `{"base64":"${'A'.repeat(2 * 1024 * 1024)}`;
    const headers = { 'Content-Type': 'application/json' };
    for (const path of ['/admin/web-returns/abc/evidence', '/admin/web-returns/abc/label', '/bot/web-returns/abc/evidence', '/bot/web-returns/abc/label']) {
      for (const body of [big, broken]) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
        if (path.startsWith('/admin')) assert.equal(res.status, 401, path);
        else assert.ok([401, 404, 503].includes(res.status), `${path}: ${res.status}`);
      }
    }
    assert.equal((await fetch(`${base}/admin/web-returns/abc/approve`, { method: 'POST', headers, body: big })).status, 413);
    // El parser global sigue andando en el resto de las rutas.
    const parsed = await fetch(`${base}/admin/web-returns/abc/approve`, { method: 'POST', headers, body: '{"a":' });
    assert.equal(parsed.status, 400);
  } finally { server.close(); }
});

test('router: con auth, evidencia y etiqueta aceptan cuerpos grandes (parser de 25 MB después del guard)', async () => {
  process.env.POS_BOT_SECRET = 'secreto-bot';
  const deps = mkDeps();
  deps.current = { ...deps.current, status: 'pendiente_aprobacion' };
  const app = express();
  app.use(jsonExceptBigBodies());
  app.use('/api/pos', createWebReturnsRouter({ admins: [requirePosAuth, requirePosRole('admin')], deps }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/pos`;
  try {
    const big = JSON.stringify({ base64: 'A'.repeat(2 * 1024 * 1024), mimetype: 'image/png' });
    const token = generateToken({ id: 'a1', role: 'admin', name: 'Admin' });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const res = await fetch(`${base}/admin/web-returns/r1/evidence`, { method: 'POST', headers, body: big });
    assert.equal(res.status, 200);
    assert.equal(deps.calls.find((c) => c[0] === 'save')[1].base64.length, 2 * 1024 * 1024);
    const bot = await fetch(`${base}/bot/web-returns/r1/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pos-bot-key': 'secreto-bot' }, body: big });
    assert.equal(bot.status, 200);
    assert.equal((await fetch(`${base}/admin/web-returns/r1/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })).status, 401);
  } finally { server.close(); }
});

test('router: buscar el pedido al editar descuenta todo menos la propia solicitud (?exclude=<id>)', async () => {
  const { resolveWebPurchase } = await import('../posWebReturnsPurchase.mjs');
  const pending = { id: 'r1', number: 'CW-000001', status: 'pendiente_aprobacion', purchase: { purchaseId: '77' }, returnLines: [{ purchaseLineId: '10', qty: 2 }], odoo: { steps: {} } };
  const pdeps = {
    findOrderByNumber: async () => ({ id: 999, number: '123', customer: {} }),
    findSaleOrder: async () => ({ id: 77, warehouse_id: [24, 'EC'] }),
    getPurchase: async () => ({ source: 'web', purchaseId: '77', date: '2026-11-02 13:00:00', lines: [{ ...purchaseLine, purchaseLineId: '10' }] }),
    readReturnMoves: async () => [],
    activeRequests: async () => [pending],
    settings: { webReturns: { warehouseId: 24 } },
  };
  const deps = mkDeps({ resolve: (n, opts) => resolveWebPurchase(n, pdeps, opts) });
  const app = express();
  app.use(express.json());
  app.use('/api/pos', createWebReturnsRouter({ admins: [requirePosAuth, requirePosRole('admin')], deps }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/pos`;
  try {
    const headers = { Authorization: `Bearer ${generateToken({ id: 'a1', role: 'admin', name: 'Admin' })}` };
    const own = await fetch(`${base}/admin/web-returns/purchase/123?exclude=r1`, { headers });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).returnable[0].available, 2);
    const fresh = await fetch(`${base}/admin/web-returns/purchase/123`, { headers });
    assert.match((await fresh.json()).error, /ya no tiene productos para devolver/);
    assert.equal((await fetch(`${base}/admin/web-returns/purchase/123?exclude=a.b`, { headers })).status, 400);
  } finally { server.close(); }
});
