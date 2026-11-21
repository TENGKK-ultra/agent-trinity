import { describe, expect, it } from 'vitest';
import { formatCost, formatTokens } from './format';

describe('usage formatting', () => {
  it('把 Provider 的美元成本换算成估算人民币', () => {
    expect(formatCost(0.061208)).toBe('¥0.41');
  });

  it('未知成本保持未知，不换算成零', () => {
    expect(formatCost(null)).toBe('—');
  });

  it('真实的零成本显示为零，而不是未知', () => {
    expect(formatCost(0)).toBe('¥0.00');
  });

  it('Token 的未知与数字区分', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(1290)).toBe('1,290');
  });
});
