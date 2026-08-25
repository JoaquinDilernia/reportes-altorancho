// backend/test/meta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDateRange, extractActionValue } from '../meta.mjs';

test('chunkDateRange returns a single chunk when the range fits within maxDays', () => {
  const chunks = chunkDateRange('2026-08-01', '2026-08-01', 90);
  assert.deepEqual(chunks, [{ since: '2026-08-01', until: '2026-08-01' }]);
});

test('chunkDateRange splits a range into consecutive, non-overlapping windows', () => {
  const chunks = chunkDateRange('2026-01-01', '2026-01-05', 2);
  assert.deepEqual(chunks, [
    { since: '2026-01-01', until: '2026-01-02' },
    { since: '2026-01-03', until: '2026-01-04' },
    { since: '2026-01-05', until: '2026-01-05' },
  ]);
});

test('extractActionValue returns 0 when the actions array is missing', () => {
  assert.equal(extractActionValue(undefined, 'omni_purchase'), 0);
});

test('extractActionValue returns 0 when the action_type is not present', () => {
  const actions = [{ action_type: 'link_click', value: '41871' }];
  assert.equal(extractActionValue(actions, 'omni_purchase'), 0);
});

test('extractActionValue returns the numeric value when the action_type matches', () => {
  const actions = [{ action_type: 'omni_purchase', value: '87' }];
  assert.equal(extractActionValue(actions, 'omni_purchase'), 87);
});
