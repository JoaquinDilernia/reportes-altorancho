import { describe, it, expect } from 'vitest';
import { heatLevel, upt } from './localesFormat.js';

describe('localesFormat', () => {
  it('heatLevel: 0..4 relative to the max', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(3, 0)).toBe(0);
  });

  it('upt: units per ticket, comma decimals, dash when missing', () => {
    expect(upt(1.5)).toBe('1,5');
    expect(upt(2.78)).toBe('2,78');
    expect(upt(null)).toBe('—');
  });
});
