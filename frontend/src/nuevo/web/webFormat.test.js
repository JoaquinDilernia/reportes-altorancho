import { describe, it, expect } from 'vitest';
import { rate, mmss, sourceLabel, convPpDelta, weakSources } from './webFormat.js';

describe('webFormat', () => {
  it('rate shows a fraction as a percentage', () => {
    expect(rate(0.004559)).toBe('0,46%');
    expect(rate(0.25, 0)).toBe('25%');
    expect(rate(null)).toBe('—');
  });

  it('mmss formats seconds', () => {
    expect(mmss(137.6)).toBe('2:18');
    expect(mmss(59.6)).toBe('1:00');
    expect(mmss(null)).toBe('—');
  });

  it('sourceLabel translates GA4 groups and keeps unknown ones', () => {
    expect(sourceLabel('Cross-network')).toBe('Google PMax / Demand Gen');
    expect(sourceLabel('Something New')).toBe('Something New');
  });

  it('convPpDelta is the difference in percentage points', () => {
    expect(convPpDelta(0.0046, 0.004)).toBeCloseTo(0.06, 5);
    expect(convPpDelta(0.0046, null)).toBe(null);
  });

  it('weakSources flags big sources converting under a third of the site', () => {
    const rows = [
      { key: 'Cross-network', cur: { sessions: 5000, conversion: 0.0008 } },
      { key: 'Direct', cur: { sessions: 3000, conversion: 0.01 } },
      { key: 'Email', cur: { sessions: 50, conversion: 0 } },
    ];
    expect([...weakSources(rows, 0.005)]).toEqual(['Cross-network']);
  });
});
