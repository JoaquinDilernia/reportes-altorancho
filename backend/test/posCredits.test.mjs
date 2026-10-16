import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  creditExpiry, isUsable, allocateCredits, buildCredit, applyAllocation, consumeCreditsInTx,
} from '../posCredits.mjs';

const DAY = 864e5;
const NOW = Date.parse('2026-10-16T12:00:00-03:00');
const credit = (id, balance, expiresInDays, createdDaysAgo = 1) => ({
  id, balance, status: balance > 0 ? 'activo' : 'agotado', movements: [],
  expiresAt: expiresInDays == null ? null : new Date(NOW + expiresInDays * DAY),
  createdAt: new Date(NOW - createdDaysAgo * DAY),
});

test('creditExpiry: null = no vence', () => {
  assert.equal(creditExpiry(NOW, null), null);
  assert.equal(creditExpiry(NOW, 30).getTime(), NOW + 30 * DAY);
});

test('isUsable: con saldo y sin vencer', () => {
  assert.ok(isUsable(credit('a', 100, 5), NOW));
  assert.ok(isUsable(credit('a', 100, null), NOW));
  assert.ok(!isUsable(credit('a', 100, -1), NOW));
  assert.ok(!isUsable(credit('a', 0, 5), NOW));
});

test('allocateCredits: primero el que vence antes; los que no vencen al final; vencidos no', () => {
  const credits = [credit('sinVto', 500, null), credit('pronto', 300, 2), credit('tarde', 400, 20), credit('vencido', 999, -3)];
  assert.deepEqual(allocateCredits(credits, 600, NOW), [{ creditId: 'pronto', amount: 300 }, { creditId: 'tarde', amount: 300 }]);
  assert.throws(() => allocateCredits(credits, 1300, NOW), /tiene \$ 1\.200 de saldo a favor y se quiere usar \$ 1\.300/);
});

test('buildCredit y applyAllocation', () => {
  const order = { id: 'o1', number: 'LL-0042', localId: 'LL', customer: { docNumber: '30123456', name: 'Ana', odooPartnerId: 91779 } };
  const c = buildCredit({ order, amount: 1000, days: 30, nowMs: NOW, user: 'Caja LL', creditNoteIds: [5] });
  assert.equal(c.customerDoc, '30123456');
  assert.equal(c.balance, 1000);
  assert.equal(c.status, 'activo');
  assert.equal(c.expiresAt.getTime(), NOW + 30 * DAY);
  assert.equal(c.movements[0].type, 'alta');
  const used = applyAllocation({ ...c, id: 'o1' }, 1000, { orderId: 'o2', orderNumber: 'BL-0003', user: 'Caja BL', at: new Date(NOW) });
  assert.equal(used.balance, 0);
  assert.equal(used.status, 'agotado');
  assert.equal(used.movements.at(-1).type, 'uso');
});

// Transacción falsa: guarda escrituras para verlas después.
function fakeTx(docs) {
  const writes = [];
  return {
    writes,
    tx: {
      get: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => d })) }),
      update: (ref, data) => writes.push([ref.id, data]),
    },
    db: { collection: () => ({ where: () => ({}), doc: (id) => ({ id }) }) },
  };
}

test('consumeCreditsInTx: descuenta en la misma transacción; si no alcanza, tira antes de escribir', async () => {
  const { tx, db, writes } = fakeTx([credit('pronto', 300, 2), credit('tarde', 400, 20)]);
  const { allocation, commit } = await consumeCreditsInTx(tx, db, { docNumber: '30123456', amount: 500, orderId: 'o9', orderNumber: 'LL-0050', user: 'Caja', nowMs: NOW });
  assert.deepEqual(allocation, [{ creditId: 'pronto', amount: 300 }, { creditId: 'tarde', amount: 200 }]);
  assert.equal(writes.length, 0);
  commit();
  assert.deepEqual(writes.map(([id, d]) => [id, d.balance]), [['pronto', 0], ['tarde', 200]]);
  const second = fakeTx([credit('pronto', 0, 2), credit('tarde', 200, 20)]);
  await assert.rejects(consumeCreditsInTx(second.tx, second.db, { docNumber: '30123456', amount: 500, orderId: 'o10', orderNumber: 'LL-0051', user: 'Caja', nowMs: NOW }), /saldo a favor/);
  assert.equal(second.writes.length, 0);
});
