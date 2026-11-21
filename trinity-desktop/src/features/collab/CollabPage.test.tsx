import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabDetailDto, CollabRoundDto } from '../../services/core-api';
import { CollabPage } from './CollabPage';

const mocks = vi.hoisted(() => ({
  listCollabRounds: vi.fn(),
  getCollabRound: vi.fn(),
  listConversations: vi.fn(),
  getAgent: vi.fn(),
  createCollabRound: vi.fn(),
  cancelCollabRound: vi.fn(),
  resumeCollabRound: vi.fn(),
}));

vi.mock('../../services/core-api', () => ({
  listCollabRounds: mocks.listCollabRounds,
  getCollabRound: mocks.getCollabRound,
  listConversations: mocks.listConversations,
  getAgent: mocks.getAgent,
  createCollabRound: mocks.createCollabRound,
  cancelCollabRound: mocks.cancelCollabRound,
  resumeCollabRound: mocks.resumeCollabRound,
}));

function round(overrides: Partial<CollabRoundDto> = {}): CollabRoundDto {
  return {
    id: 'r1',
    conversation_id: 'c1',
    goal: '做一份 PPT',
    status: 'delivered',
    outcome: 'completed',
    coordinator: 'codex',
    review_required: true,
    min_assignments: 0,
    blocked_phase: null,
    budgets: {
      hops: { used: 2, limit: 10 },
      exec: { used: 5, limit: 12 },
      usage_tokens: { limit: null },
    },
    blocked_reason: null,
    wake_condition: null,
    delivery_message_id: 'm1',
    created_at: '2026-11-20T08:00:00.000Z',
    closed_at: '2026-11-20T08:10:00.000Z',
    conversation_title: '项目讨论',
    ...overrides,
  };
}

function detail(overrides: Partial<CollabDetailDto> = {}): CollabDetailDto {
  return {
    round: round(),
    roles: [
      {
        round_id: 'r1',
        agent: 'codex',
        role: 'coordinator',
        assigned_by: 'user',
        reason: '本轮由 codex 负责',
        assigned_at: '2026-11-20T08:00:00.000Z',
      },
      {
        round_id: 'r1',
        agent: 'claude',
        role: 'contributor',
        assigned_by: 'user',
        reason: '默认参与本轮',
        assigned_at: '2026-11-20T08:00:00.000Z',
      },
    ],
    tasks: [
      {
        id: 't1',
        target_agent: 'claude',
        source_agent: 'codex',
        task_type: 'writing',
        title: '写提纲',
        instruction_preview: '写提纲',
        status: 'completed',
        error_text: null,
        result_message_id: 'm2',
        created_at: '2026-11-20T08:01:00.000Z',
        started_at: '2026-11-20T08:01:01.000Z',
        finished_at: '2026-11-20T08:02:00.000Z',
      },
    ],
    messages: [
      {
        id: 'am1',
        kind: 'assignment',
        from_agent: 'codex',
        to_agent: 'claude',
        content: '写提纲',
        reason: '主笔',
        state: 'task_completed',
        hop: 1,
        task_id: 't1',
        created_at: '2026-11-20T08:01:00.000Z',
      },
    ],
    contributions: [],
    reviews: [
      {
        id: 'rv1',
        producer: 'claude',
        reviewer: 'deepseek',
        same_provider: false,
        status: 'pass',
        findings: [],
        created_at: '2026-11-20T08:05:00.000Z',
      },
    ],
    usage: { tokens: 1200, cost_usd: 0.01, rows: 3 },
    delivery: {
      id: 'm1',
      content: '【协作交付】做一份 PPT\n结论：completed',
      message_type: 'agent_final',
      created_at: '2026-11-20T08:10:00.000Z',
    },
    ...overrides,
  };
}

describe('CollabPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listConversations.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue({
      agent: null,
      active_agent: null,
      available: [],
      bindings: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('没有轮次时给出清晰的入口提示', async () => {
    mocks.listCollabRounds.mockResolvedValue({ items: [] });

    render(<CollabPage />);

    expect(await screen.findByText('还没有协作轮次')).toBeTruthy();
    expect(screen.getByRole('button', { name: /发起协作/ })).toBeTruthy();
  });

  it('展示目标、状态、角色、任务、审查与最终交付', async () => {
    mocks.listCollabRounds.mockResolvedValue({ items: [round()] });
    mocks.getCollabRound.mockResolvedValue(detail());

    render(<CollabPage />);

    expect((await screen.findAllByText('写提纲')).length).toBeGreaterThan(0);
    expect(screen.getByText('需要独立审查')).toBeTruthy();
    expect(screen.getByText('协调者：Codex')).toBeTruthy();
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.getByText('审查者：DeepSeek Harness · 不同 Provider')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText(/【协作交付】/)).toBeTruthy();
    expect(screen.getByText('2 / 10 跳')).toBeTruthy();
    expect(screen.getByText('5 / 12 回合')).toBeTruthy();
    expect(screen.getByText('1200 tokens（不限）')).toBeTruthy();
  });

  it('分工要求未满足时，可以放宽要求继续', async () => {
    const blockedRound = round({
      status: 'blocked',
      outcome: null,
      min_assignments: 2,
      blocked_phase: 'planning',
      blocked_reason: '用户要求至少 2 个 Agent 分工，协调者只派出了 0 个',
      wake_condition: 'user_decision',
      closed_at: null,
    });
    mocks.listCollabRounds.mockResolvedValue({ items: [blockedRound] });
    mocks.getCollabRound.mockResolvedValue(detail({ round: blockedRound }));

    render(<CollabPage />);

    expect((await screen.findAllByText(/至少 2 个 Agent 分工/)).length).toBeGreaterThan(0);
    expect(screen.getByText('要求至少 2 个 Agent 分工')).toBeTruthy();
    expect(screen.getByRole('button', { name: '放宽分工要求并继续' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '要求重新规划' })).toBeTruthy();
  });

  it('传播超限时，可以输入新的 hop 上限并恢复', async () => {
    const blockedRound = round({
      status: 'blocked',
      outcome: null,
      blocked_reason: 'propagation_limit_reached：本轮传播 hop 已达上限 10，协调者无法继续传递',
      wake_condition: 'propagation_limit',
      blocked_phase: 'work',
      closed_at: null,
    });
    mocks.listCollabRounds.mockResolvedValue({ items: [blockedRound] });
    mocks.getCollabRound.mockResolvedValue(detail({ round: blockedRound }));

    render(<CollabPage />);

    expect((await screen.findAllByText(/用户提高传播预算/)).length).toBeGreaterThan(0);

    const resume = screen.getByRole('button', {
      name: '提高传播上限并继续',
    }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    expect(resume.disabled).toBe(false);
  });

  it('部分完成与等待审批都直接可见', async () => {
    const blockedRound = round({
      status: 'blocked',
      outcome: null,
      blocked_reason: '用量预算已耗尽',
      wake_condition: 'user_approval',
      closed_at: null,
    });
    mocks.listCollabRounds.mockResolvedValue({ items: [blockedRound] });
    mocks.getCollabRound.mockResolvedValue(
      detail({
        round: blockedRound,
        reviews: [
          {
            id: 'rv2',
            producer: 'claude',
            reviewer: null,
            same_provider: null,
            status: 'review_unavailable',
            findings: ['没有可用的独立审查者'],
            created_at: '2026-11-20T08:05:00.000Z',
          },
        ],
      }),
    );

    render(<CollabPage />);

    expect(await screen.findByText('用量预算已耗尽')).toBeTruthy();
    expect(screen.getByText('审查者：无（不可用）')).toBeTruthy();
    expect(screen.getByText('不可用')).toBeTruthy();

    const resume = screen.getByRole('button', { name: '提高上限并恢复' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '200000' } });
    expect(resume.disabled).toBe(false);
  });
});
