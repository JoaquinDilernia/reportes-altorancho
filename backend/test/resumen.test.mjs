import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESUMEN_CHANNELS, sparkRanges, channelBreakdown, dailyStacked, buildKpis } from '../resumen.mjs';
import { computeInflationAdjustedDelta } from '../aggregate.mjs';

// 15:00 UTC = 12:00 ART, safely inside the Argentine day.
const doc = (channel, day, total, status = 'completed') => ({ channel, status, date: `${day}T15:00:00.000Z`, total, items: [] });

test('RESUMEN_CHANNELS: five groups, mayorista includes feria', () => {
  assert.deepEqual(RESUMEN_CHANNELS.map(c => c.id), ['web', 'lomas', 'belgrano', 'alcorta', 'mayorista']);
  assert.deepEqual(RESUMEN_CHANNELS.find(c => c.id === 'mayorista').channels, ['mayorista', 'feria']);
});

test('sparkRanges: week → 8 consecutive weeks ending at the current one', () => {
  const r = sparkRanges({ current: { start: '2026-11-02', end: '2026-11-08' } }, 'week');
  assert.equal(r.length, 8);
  assert.deepEqual(r[0], { start: '2026-09-14', end: '2026-09-20' });
  assert.deepEqual(r[7], { start: '2026-11-02', end: '2026-11-08' });
});

test('sparkRanges: month → 12 calendar months', () => {
  const r = sparkRanges({ current: { start: '2026-10-01', end: '2026-10-31' } }, 'month');
  assert.equal(r.length, 12);
  assert.deepEqual(r[0], { start: '2025-11-01', end: '2025-11-30' });
  assert.deepEqual(r[10], { start: '2026-09-01', end: '2026-09-30' });
  assert.deepEqual(r[11], { start: '2026-10-01', end: '2026-10-31' });
});

test('sparkRanges: custom → contiguous ranges of the same length', () => {
  const r = sparkRanges({ current: { start: '2026-11-01', end: '2026-11-10' } }, 'custom');
  assert.equal(r.length, 8);
  assert.deepEqual(r[6], { start: '2026-10-22', end: '2026-10-31' });
  assert.deepEqual(r[7], { start: '2026-11-01', end: '2026-11-10' });
});

test('channelBreakdown: feria counts in mayorista, shares add up to 100, delta null with no previous', () => {
  const cur = [doc('ecommerce', '2026-11-02', 600), doc('mayorista', '2026-11-02', 200), doc('feria', '2026-11-03', 100),
    doc('local_lomas', '2026-11-02', 100), doc('local_lomas', '2026-11-02', 999, 'cancelled')];
  const prev = [doc('ecommerce', '2026-10-26', 300), doc('mayorista', '2026-10-26', 300)];
  const rows = channelBreakdown(cur, prev);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.mayorista.revenue, 300);
  assert.equal(by.mayorista.orders, 2);
  assert.equal(by.mayorista.deltaPct, 0);
  assert.equal(by.web.deltaPct, 100);
  assert.equal(by.lomas.revenue, 100);
  assert.equal(by.lomas.deltaPct, null);
  assert.equal(by.belgrano.deltaPct, null);
  const shareSum = rows.reduce((s, r) => s + r.sharePct, 0);
  assert.ok(Math.abs(shareSum - 100) <= 0.1, `share sum ${shareSum}`);
});

test('dailyStacked: 7-day range → 7 rows, the empty day at 0, prev year aligned and adjusted', () => {
  const cur = [doc('ecommerce', '2026-11-02', 100), doc('local_belgrano', '2026-11-02', 50), doc('feria', '2026-11-04', 10)];
  const prevYear = [doc('ecommerce', '2025-11-02', 40)];
  const { bucket, rows } = dailyStacked(cur, prevYear, { start: '2026-11-02', end: '2026-11-08', prevYearFactor: 2 });
  assert.equal(bucket, 'day');
  assert.equal(rows.length, 7);
  assert.equal(rows[0].key, '2026-11-02');
  assert.deepEqual(rows[0].byChannel, { web: 100, lomas: 0, belgrano: 50, alcorta: 0, mayorista: 0 });
  assert.equal(rows[0].total, 150);
  assert.equal(rows[0].prevYearAdj, 80);
  assert.equal(rows[1].total, 0);
  assert.equal(rows[2].byChannel.mayorista, 10);
});

test('dailyStacked: > 45 days → weekly buckets', () => {
  const { bucket, rows } = dailyStacked([doc('ecommerce', '2026-08-05', 100)], [], { start: '2026-08-01', end: '2026-10-29', prevYearFactor: null });
  assert.equal(bucket, 'week');
  assert.ok(rows.length >= 13 && rows.length <= 14);
  assert.equal(rows.reduce((s, r) => s + r.total, 0), 100);
});

const totals = (revenue, orders) => ({ revenue, orders, avgTicket: orders ? revenue / orders : 0 });
const baseArgs = {
  cur: totals(1000, 10), prevPeriod: totals(800, 8), prevYear: totals(500, 5),
  sparks: [totals(700, 7), totals(800, 8), totals(1000, 10)],
  ads: { cur: { spend: 100, value: 500 }, prev: { spend: 50, value: 200 }, spark: [{ spend: 50, value: 200 }, { spend: 100, value: 500 }] },
};

test('buildKpis: without web, conversion is empty', () => {
  const k = buildKpis({ ...baseArgs, inflation: { currentIndex: 200, prevYearIndex: 100 }, web: null });
  const conv = k.find(x => x.id === 'conversion');
  assert.equal(conv.value, null);
  assert.equal(conv.vsPrev, null);
  assert.deepEqual(conv.spark, []);
  assert.deepEqual(k.map(x => x.id), ['revenue', 'orders', 'avgTicket', 'conversion', 'adSpend']);
});

test('buildKpis: revenue vs year is real with indexes, nominal without', () => {
  const real = buildKpis({ ...baseArgs, inflation: { currentIndex: 200, prevYearIndex: 100 }, web: null }).find(x => x.id === 'revenue');
  assert.equal(real.vsYearKind, 'real');
  assert.equal(real.vsYear, computeInflationAdjustedDelta(1000, 500, 200, 100).pct);
  assert.equal(real.vsPrev, 25);
  assert.deepEqual(real.spark, [700, 800, 1000]);
  const nominal = buildKpis({ ...baseArgs, inflation: { currentIndex: 200, prevYearIndex: undefined }, web: null }).find(x => x.id === 'revenue');
  assert.equal(nominal.vsYearKind, 'nominal');
  assert.equal(nominal.vsYear, 100);
});

test('buildKpis: conversion in percentage points', () => {
  const web = { cur: { sessions: 1000, purchases: 20 }, prev: { sessions: 1000, purchases: 10 }, yoy: { sessions: 2000, purchases: 10 },
    spark: [{ sessions: 1000, purchases: 10 }, { sessions: 1000, purchases: 20 }] };
  const conv = buildKpis({ ...baseArgs, inflation: {}, web }).find(x => x.id === 'conversion');
  assert.equal(conv.value, 2);
  assert.equal(conv.vsPrev, 1);
  assert.equal(conv.vsYear, 1.5);
  assert.equal(conv.vsYearKind, 'pp');
  assert.deepEqual(conv.spark, [1, 2]);
});

test('buildKpis: ad spend with ROAS, null ROAS when spend is 0', () => {
  const ad = buildKpis({ ...baseArgs, inflation: {}, web: null }).find(x => x.id === 'adSpend');
  assert.equal(ad.value, 100);
  assert.equal(ad.vsPrev, 100);
  assert.deepEqual(ad.extra, { roas: 5, roasPrev: 4 });
  assert.deepEqual(ad.spark, [50, 100]);
  const zero = buildKpis({ ...baseArgs, ads: { cur: { spend: 0, value: 0 }, prev: { spend: 0, value: 0 }, spark: [] }, inflation: {}, web: null })
    .find(x => x.id === 'adSpend');
  assert.equal(zero.extra.roas, null);
  assert.equal(zero.vsPrev, null);
});
