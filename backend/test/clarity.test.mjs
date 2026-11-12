import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeClarityTotals, shapeClarityPages, pagePath } from '../clarity.mjs';

test('shapeClarityTotals: empty project (shape as returned live) → zeros, no crash', () => {
  const resp = [
    { metricName: 'RageClickCount', information: [{ sessionsCount: 0, sessionsWithMetricPercentage: 0, sessionsWithoutMetricPercentage: 100, pagesViews: 0, subTotal: 0 }] },
    { metricName: 'ScrollDepth', information: [{ averageScrollDepth: null }] },
    { metricName: 'Traffic', information: [{ totalSessionCount: 0, totalBotSessionCount: 0, distinctUserCount: 0, pagesPerSessionPercentage: null }] },
    { metricName: 'EngagementTime', information: [{ totalTime: null, activeTime: null }] },
    { metricName: 'PopularPages', information: [] },
  ];
  const t = shapeClarityTotals(resp);
  assert.equal(t.sessions, 0);
  assert.equal(t.scrollDepth, null);
  assert.deepEqual(t.signals.rage, { pct: 0, sessions: 0, count: 0 });
  assert.equal(t.signals.dead, null);
});

test('pagePath: drops domain and campaign query', () => {
  assert.equal(pagePath('https://www.altorancho.com/productos/x/?utm_source=meta'), '/productos/x/');
  assert.equal(pagePath('https://www.altorancho.com'), '/');
});

test('shapeClarityPages: groups URLs by path and turns signals into % of sessions', () => {
  const resp = [
    { metricName: 'Traffic', information: [
      { URL: 'https://www.altorancho.com/alto-cyber?utm=a', totalSessionCount: '60' },
      { URL: 'https://www.altorancho.com/alto-cyber?utm=b', totalSessionCount: '40' },
      { URL: 'https://www.altorancho.com/chica', totalSessionCount: '5' },
    ] },
    { metricName: 'RageClickCount', information: [{ URL: 'https://www.altorancho.com/alto-cyber?utm=a', sessionsCount: '10', subTotal: '25' }] },
    { metricName: 'ScrollDepth', information: [{ URL: 'https://www.altorancho.com/alto-cyber', averageScrollDepth: 42.5 }] },
  ];
  const pages = shapeClarityPages(resp);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], { path: '/alto-cyber', sessions: 100, scrollDepth: 42.5, rage: 10, dead: 0, quickback: 0 });
});
