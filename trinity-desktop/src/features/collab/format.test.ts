import { describe, expect, it } from 'vitest';
import {
  agentLabel,
  budgetPercent,
  budgetTone,
  chipClass,
  formatTime,
  isTerminal,
  outcomeTone,
  roundTone,
  taskTone,
  truncate,
  usageLabel,
} from './format';

describe('协作格式化', () => {
  it('状态到色调的映射不会把失败画成成功', () => {
    expect(roundTone('delivered')).toBe('success');
    expect(roundTone('failed')).toBe('danger');
    expect(roundTone('blocked')).toBe('warning');
    expect(roundTone('running')).toBe('accent');
    expect(outcomeTone('partially_completed')).toBe('warning');
    expect(taskTone('timeout')).toBe('danger');
    expect(chipClass('default')).toBe('chip');
    expect(chipClass('danger')).toBe('chip chip-danger');
  });

  it('终态判定与后端一致', () => {
    expect(isTerminal('delivered')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('blocked')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });

  it('预算百分比与告警阈值', () => {
    expect(budgetPercent(0, 10)).toBe(0);
    expect(budgetPercent(5, 10)).toBe(50);
    expect(budgetPercent(12, 10)).toBe(100);
    expect(budgetPercent(1, 0)).toBe(100);
    expect(budgetTone(8, 10)).toBe('warning');
    expect(budgetTone(10, 10)).toBe('danger');
    expect(budgetTone(9, 10)).toBe('warning');
    expect(budgetTone(3, 10)).toBe('default');
  });

  it('未知用量显示为统计中，而不是零', () => {
    expect(usageLabel(null, null)).toBe('统计中 tokens（不限）');
    expect(usageLabel(null, 1000)).toBe('统计中 / 1000 tokens');
    expect(usageLabel(120, null)).toBe('120 tokens（不限）');
    expect(usageLabel(120, 1000)).toBe('120 / 1000 tokens');
  });

  it('Agent 名称与截断', () => {
    expect(agentLabel('claude')).toBe('Claude Code');
    expect(agentLabel('deepseek')).toBe('DeepSeek Harness');
    expect(agentLabel(null)).toBe('未知');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('时间格式化对无效输入不抛异常', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatTime('not-a-date')).toBe('not-a-date');
    expect(formatTime('2026-11-20T08:05:09.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
