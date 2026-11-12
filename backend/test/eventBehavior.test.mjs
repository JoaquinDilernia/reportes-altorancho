import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../events.mjs';
import { behaviorRanges, cleanSearches, productsByName, shapeBehavior } from '../eventBehavior.mjs';

test('behaviorRanges: last year covers the same number of days, capped at its end', () => {
  const early = behaviorRanges(EVENTS.cyber, '2026-11-02');
  assert.deepEqual(early.cur, { start: '2026-10-29', end: '2026-11-02', days: 5 });
  assert.deepEqual(early.prev, { start: '2025-10-29', end: '2025-11-02', days: 5 });
  const late = behaviorRanges(EVENTS.cyber, '2026-11-20');
  assert.equal(late.cur.end, '2026-11-15');
  assert.equal(late.prev.end, '2025-11-09');
});

test('cleanSearches: drops empty terms and utm junk, merges case', () => {
  const out = cleanSearches([
    { searchTerm: '', eventCount: 999 },
    { searchTerm: 'Reposera', eventCount: 3 },
    { searchTerm: 'reposera', eventCount: 2 },
    { searchTerm: 'baby fungi/?utm_source=pinterest', eventCount: 4 },
  ]);
  assert.deepEqual(out, [{ term: 'reposera', count: 5 }, { term: 'baby fungi', count: 4 }]);
});

test('productsByName: sums web stock across variants, prefers one with Odoo category', () => {
  const map = productsByName(new Map([
    ['A1', { sku: 'A1', name: 'Silla Chicago Verde', currentStock: 3, odooCategPath: null }],
    ['A2', { sku: 'A2', name: 'Silla  Chicago verde', currentStock: 2, odooCategPath: 'All / Biblia / MUEBLES / SILLAS' }],
  ]));
  const e = map.get('SILLA CHICAGO VERDE');
  assert.equal(e.webStock, 5);
  assert.equal(e.product.sku, 'A2');
});

test('shapeBehavior: conversion is purchases/sessions and items land in Odoo categories', () => {
  const productsBySku = new Map([['S1', { sku: 'S1', name: 'Silla Tube', currentStock: 4, odooCategPath: 'All / Biblia / MUEBLES / SILLAS / X' }]]);
  const r = shapeBehavior({
    ranges: {},
    productsBySku,
    raw: {
      totals: [{ dateRange: 'cur', sessions: 1000, ecommercePurchases: 5, purchaseRevenue: 500 }, { dateRange: 'prev', sessions: 100, ecommercePurchases: 1, purchaseRevenue: 90 }],
      funnel: [{ dateRange: 'cur', eventName: 'purchase', totalUsers: 5 }],
      channels: [], devices: [], visitors: [], searches: [], landings: [], regions: [], hourly: [], daily: [],
      items: [
        { dateRange: 'cur', itemName: 'Silla Tube', itemsViewed: 3000, itemsAddedToCart: 30, itemsPurchased: 6, itemRevenue: 600 },
        { dateRange: 'prev', itemName: 'Silla Tube', itemsViewed: 100, itemsAddedToCart: 1, itemsPurchased: 1, itemRevenue: 50 },
      ],
    },
  });
  assert.equal(r.totals.cur.conversion, 0.005);
  assert.equal(r.totals.cur.avgTicket, 100);
  const sillas = r.items.categories.find(c => c.id === 'sillas');
  assert.equal(sillas.views, 3000);
  assert.equal(sillas.prevViews, 100);
  assert.equal(r.items.lowConversion[0].webStock, 4);
  assert.equal(r.funnel.cur.find(s => s.id === 'purchase').users, 5);
});
