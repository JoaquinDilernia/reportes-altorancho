// backend/test/meta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDateRange, extractActionValue, normalizeDailyInsightRow, normalizeAdDailyInsightRow } from '../meta.mjs';

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

// Live-captured shape once action_attribution_windows=['1d_click'] is
// requested: each action carries the '1d_click' breakdown alongside the
// blended `value`, which mixes each ad set's own attribution setting.
test('extractActionValue prefers the 1d_click breakdown over the blended value', () => {
  const actions = [{ action_type: 'omni_purchase', value: '342', '1d_click': '275' }];
  assert.equal(extractActionValue(actions, 'omni_purchase'), 275);
});

// Shape captured live from GET /act_.../insights?level=account&time_increment=1
const ACCOUNT_ROW = {
  spend: '5854683.64', impressions: '1243756', reach: '573702', clicks: '50699',
  actions: [
    { action_type: 'omni_purchase', value: '87' },
    { action_type: 'omni_add_to_cart', value: '1155' },
    { action_type: 'omni_initiated_checkout', value: '214' },
    { action_type: 'omni_landing_page_view', value: '35348' },
    { action_type: 'link_click', value: '41871' },
  ],
  action_values: [{ action_type: 'omni_purchase', value: '28173257.6' }],
  date_start: '2026-08-18', date_stop: '2026-08-18',
};

test('normalizeDailyInsightRow maps Meta field names to the stored doc shape', () => {
  const doc = normalizeDailyInsightRow(ACCOUNT_ROW, 'ARS');
  assert.deepEqual(doc, {
    date: '2026-08-18', spend: 5854683.64, impressions: 1243756, reach: 573702, clicks: 50699,
    purchases: 87, purchaseValue: 28173257.6, addToCart: 1155, initiateCheckout: 214,
    landingPageViews: 35348, currency: 'ARS',
  });
});

test('normalizeDailyInsightRow defaults conversion metrics to 0 when actions/action_values are absent', () => {
  const row = { spend: '2521.19', impressions: '8504', reach: '8059', clicks: '2', date_start: '2026-08-20' };
  const doc = normalizeDailyInsightRow(row, 'ARS');
  assert.equal(doc.purchases, 0);
  assert.equal(doc.purchaseValue, 0);
  assert.equal(doc.addToCart, 0);
});

test('normalizeAdDailyInsightRow adds ad identity fields on top of the daily shape', () => {
  const row = {
    ...ACCOUNT_ROW,
    ad_id: '120248373465940142', ad_name: 'altorancho_boost_reel_fabrica',
    campaign_name: 'altorancho_conversiones_broad_aon', adset_name: 'altorancho_conversiones_broad_aon',
  };
  const doc = normalizeAdDailyInsightRow(row, 'ARS');
  assert.equal(doc.adId, '120248373465940142');
  assert.equal(doc.adName, 'altorancho_boost_reel_fabrica');
  assert.equal(doc.campaignName, 'altorancho_conversiones_broad_aon');
  assert.equal(doc.adsetName, 'altorancho_conversiones_broad_aon');
  assert.equal(doc.purchases, 87); // still normalizes the shared metrics
});
