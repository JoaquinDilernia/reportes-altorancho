import { describe, it, expect } from 'vitest';
import { money, pct, pp, num } from './format.js';

describe('format', () => {
  it('money', () => {
    expect(money(412_000_000)).toBe('$412M');
    expect(money(9_800_000)).toBe('$9,8M');
    expect(money(321_400)).toBe('$321K');
    expect(money(950)).toBe('$950');
    expect(money(-2_500_000)).toBe('−$2,5M');
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
  });
  it('pct', () => {
    expect(pct(-3.2, { sign: true })).toBe('−3%');
    expect(pct(6, { sign: true })).toBe('+6%');
    expect(pct(0.46, { decimals: 2 })).toBe('0,46%');
    expect(pct(null)).toBe('—');
  });
  it('pp', () => {
    expect(pp(-0.08)).toBe('−0,08 pp');
    expect(pp(0.5)).toBe('+0,5 pp');
    expect(pp(null)).toBe('—');
  });
  it('num', () => {
    expect(num(1284)).toBe('1.284');
    expect(num(null)).toBe('—');
  });
});
