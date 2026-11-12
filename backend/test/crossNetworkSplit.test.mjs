import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCrossNetwork } from '../eventBehavior.mjs';

const CH = 'sessionDefaultChannelGroup';
const TYPE = 'sessionGoogleAdsCampaignType';
const row = (o) => ({ sessions: 0, ecommercePurchases: 0, purchaseRevenue: 0, ...o });

test('splitCrossNetwork: Cross-network se reemplaza por Demand Gen, PMax y otro, por rango', () => {
  const channels = [
    row({ [CH]: 'Cross-network', dateRange: 'cur', sessions: 241 }),
    row({ [CH]: 'Direct', dateRange: 'cur', sessions: 50, ecommercePurchases: 2 }),
    row({ [CH]: 'Cross-network', dateRange: 'prev', sessions: 30 }),
  ];
  const cross = [
    row({ [TYPE]: 'Demand Gen', dateRange: 'cur', sessions: 181 }),
    row({ [TYPE]: 'Performance Max', dateRange: 'cur', sessions: 54, ecommercePurchases: 179, purchaseRevenue: 60 }),
    row({ [TYPE]: '(not set)', dateRange: 'cur', sessions: 6 }),
    row({ [TYPE]: 'Performance Max', dateRange: 'prev', sessions: 30 }),
  ];
  const out = splitCrossNetwork(channels, cross);
  const keys = out.map(r => `${r[CH]}|${r.dateRange}|${r.sessions}`);
  assert.deepEqual(keys, [
    'Direct|cur|50',
    'Google Demand Gen|cur|181',
    'Google PMax|cur|54',
    'Google cross-network (otro)|cur|6',
    'Google PMax|prev|30',
  ]);
  assert.equal(out.find(r => r[CH] === 'Google PMax' && r.dateRange === 'cur').ecommercePurchases, 179);
});

test('splitCrossNetwork: sin el desglose deja Cross-network como estaba', () => {
  const channels = [row({ [CH]: 'Cross-network', dateRange: 'cur', sessions: 241 })];
  assert.deepEqual(splitCrossNetwork(channels, undefined), channels);
});
