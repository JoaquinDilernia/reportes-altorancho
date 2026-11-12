import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feriaSyncWindow } from '../sync/feria.mjs';

const STARTED = new Date('2026-11-12T15:00:00.000Z');

test('feriaSyncWindow: el cursor nuevo es el inicio de la sync (con 1 min de solape), no el final', () => {
  const w = feriaSyncWindow({ lastSyncedAt: '2026-11-12T11:00:00.000Z', teamsBackfilled: true }, undefined, STARTED);
  assert.equal(w.since, '2026-11-12 11:00:00');
  assert.equal(w.nextMeta(5).lastSyncedAt, '2026-11-12T14:59:00.000Z');
});

test('feriaSyncWindow: sin backfill de equipos hace una lectura completa y lo marca hecho', () => {
  const w = feriaSyncWindow({ lastSyncedAt: '2026-11-12T11:00:00.000Z' }, undefined, STARTED);
  assert.equal(w.since, '2000-01-01 00:00:00');
  assert.deepEqual(w.nextMeta(7), { lastSyncedAt: '2026-11-12T14:59:00.000Z', count: 7, teamsBackfilled: true });
});

test('feriaSyncWindow: una corrida con sinceOverride no da por hecho el backfill de equipos', () => {
  const w = feriaSyncWindow({ lastSyncedAt: '2026-11-12T11:00:00.000Z' }, '2026-05-01 00:00:00', STARTED);
  assert.equal(w.since, '2026-05-01 00:00:00');
  assert.equal(w.nextMeta(3).teamsBackfilled, false);
});

test('feriaSyncWindow: sinceOverride mantiene un backfill ya hecho', () => {
  const w = feriaSyncWindow({ lastSyncedAt: '2026-11-12T11:00:00.000Z', teamsBackfilled: true }, '2026-05-01 00:00:00', STARTED);
  assert.equal(w.nextMeta(3).teamsBackfilled, true);
});
