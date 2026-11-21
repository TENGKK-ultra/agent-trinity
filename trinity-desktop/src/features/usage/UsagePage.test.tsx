import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePage, buildChartDays } from './UsagePage';

const mocks = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  getUsageDaily: vi.fn(),
}));

vi.mock('../../services/core-api', () => ({
  getUsageSummary: mocks.getUsageSummary,
  getUsageDaily: mocks.getUsageDaily,
}));

const emptyTotals = {
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  total_tokens: null,
  cost_usd: null,
};

function summary(totals = emptyTotals) {
  return {
    filters: { from: null, to: null, agent: null, configured_model: null },
    totals,
    by_agent: [],
    by_model: [],
  };
}

describe('UsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUsageSummary.mockResolvedValue(summary());
    mocks.getUsageDaily.mockResolvedValue({
      filters: { from: null, to: null, agent: null, configured_model: null },
      days: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('展示汇总、分组与缺失成本', async () => {
    mocks.getUsageSummary.mockResolvedValue({
      filters: { from: null, to: null, agent: null, configured_model: null },
      totals: {
        input_tokens: 1234,
        output_tokens: 56,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 1290,
        cost_usd: null,
      },
      by_agent: [
        {
          agent: 'claude',
          input_tokens: 1234,
          output_tokens: 56,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 1290,
          cost_usd: null,
        },
      ],
      by_model: [
        {
          configured_model: null,
          input_tokens: 1234,
          output_tokens: 56,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 1290,
          cost_usd: null,
        },
      ],
    });
    mocks.getUsageDaily.mockResolvedValue({
      filters: { from: null, to: null, agent: null, configured_model: null },
      days: [
        {
          date: '2026-11-20',
          input_tokens: 1234,
          output_tokens: 56,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 1290,
          cost_usd: null,
        },
      ],
    });

    render(<UsagePage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('1,290').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.getByText('未配置模型')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('没有数据时显示空状态，而不是假数字', async () => {
    render(<UsagePage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('这段时间没有用量记录。')).toBeTruthy();
  });

  it('切换 Agent 会带着过滤条件重新请求', async () => {
    render(<UsagePage />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'codex' } });
    await act(async () => {
      await Promise.resolve();
    });

    const lastCall = mocks.getUsageSummary.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ agent: 'codex' });
    expect(mocks.getUsageDaily.mock.calls.at(-1)?.[0]).toMatchObject({ agent: 'codex' });
  });

  it('请求失败显示错误与重试', async () => {
    mocks.getUsageSummary.mockRejectedValue(new Error('boom'));
    mocks.getUsageDaily.mockRejectedValue(new Error('boom'));

    render(<UsagePage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/无法加载用量数据/)).toBeTruthy();
    expect(screen.getByText('重试')).toBeTruthy();
  });
});

describe('buildChartDays', () => {
  it('补齐范围内的空档，且不伪造零值', () => {
    const days = buildChartDays('2026-11-01', '2026-11-03', [
      {
        date: '2026-11-02',
        input_tokens: 10,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 11,
        cost_usd: null,
      },
    ]);

    expect(days).toHaveLength(3);
    expect(days[0]).toEqual({ date: '2026-11-01', row: null });
    expect(days[1]?.row?.total_tokens).toBe(11);
    expect(days[2]).toEqual({ date: '2026-11-03', row: null });
  });
});
