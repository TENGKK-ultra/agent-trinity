import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from '../../components/Inspector';
import { ConversationControlsProvider } from '../../hooks/useConversationControls';
import { InspectorProvider } from '../../hooks/useInspector';
import { ActivityPage } from './ActivityPage';

vi.mock('../../hooks/useCoreStatus', () => ({
  useCore: () => ({ state: 'connected', lastCheckedAt: null, lastError: null }),
}));

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getAgent: vi.fn(),
  listActivity: vi.fn(),
  listAllTasks: vi.fn(),
  getTaskDetail: vi.fn(),
  getTaskUsage: vi.fn(),
  getActivityItem: vi.fn(),
  getUsageSummary: vi.fn(),
}));

vi.mock('../../services/core-api', () => ({
  listConversations: mocks.listConversations,
  getAgent: mocks.getAgent,
  listActivity: mocks.listActivity,
  listAllTasks: mocks.listAllTasks,
  getTaskDetail: mocks.getTaskDetail,
  getTaskUsage: mocks.getTaskUsage,
  getActivityItem: mocks.getActivityItem,
  getUsageSummary: mocks.getUsageSummary,
}));

const conversation = {
  id: 'conv-a',
  project_id: null,
  title: '对话 A',
  status: 'active' as const,
  created_at: '2026-11-19T00:00:00.000Z',
  updated_at: '2026-11-19T00:00:00.000Z',
};

const agentState = {
  agent: 'claude',
  active_agent: 'claude',
  available: ['claude', 'codex', 'deepseek'],
  bindings: [
    {
      agent: 'claude',
      display_name: 'Claude Code',
      active: true,
      status: 'running' as const,
      native_session_id: null,
      cwd: null,
      model: null,
      last_seen_at: null,
    },
    {
      agent: 'deepseek',
      display_name: 'DeepSeek Harness',
      active: false,
      status: 'idle' as const,
      native_session_id: null,
      cwd: null,
      model: null,
      last_seen_at: null,
    },
  ],
};

function activityItem(seq: number, preview: string) {
  return {
    seq,
    message_id: `m-${seq}`,
    conversation_id: 'conv-a',
    agent: 'claude',
    sender_id: 'Claude Code',
    kind: seq % 2 === 0 ? 'tool_call' : 'tool_result',
    content_preview: preview,
    metadata: (seq % 2 === 0 ? { tool: 'Read' } : null) as Record<string, unknown> | null,
    created_at: '2026-11-19T12:00:00.000Z',
  };
}

function activityPage(items: ReturnType<typeof activityItem>[], hasMore = false) {
  return { items, head_seq: items.at(-1)?.seq ?? 0, has_more: hasMore, limit: 50 };
}

const task = {
  id: 'task-1',
  conversation_id: 'conv-a',
  parent_task_id: null,
  chain_id: 'task-1',
  depth: 0,
  source_agent: 'claude',
  source_turn_id: 'turn-1',
  target_agent: 'deepseek',
  target_turn_id: 'turn-2',
  title: 'Dashboard 验收',
  instruction_preview: '检查迁移文件',
  instruction_length: 6,
  status: 'completed',
  delivery_status: 'delivered',
  result_message_id: 'm-result',
  error_text: null,
  created_at: '2026-11-19T12:00:00.000Z',
  started_at: null,
  finished_at: null,
  conversation_title: '对话 A',
};

function renderPage() {
  return render(
    <InspectorProvider>
      <ConversationControlsProvider>
        <ActivityPage />
        <Inspector />
      </ConversationControlsProvider>
    </InspectorProvider>,
  );
}

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mocks.listConversations.mockResolvedValue({
      items: [conversation],
      total: 1,
      limit: 50,
      offset: 0,
    });
    mocks.getAgent.mockResolvedValue(agentState);
    mocks.listAllTasks.mockResolvedValue({ items: [task], total: 1, limit: 50, offset: 0 });
    mocks.getTaskDetail.mockResolvedValue({
      task,
      result: { message_id: 'm-result', content_preview: '结果内容', created_at: task.created_at },
    });
    mocks.getUsageSummary.mockResolvedValue({
      filters: { from: null, to: null, agent: null, configured_model: null },
      totals: {
        input_tokens: 120,
        output_tokens: 8,
        cache_read_tokens: 40,
        cache_write_tokens: 0,
        total_tokens: 168,
        cost_usd: null,
      },
      by_agent: [],
      by_model: [],
    });
    mocks.getTaskUsage.mockResolvedValue({
      task_id: 'task-1',
      conversation_id: 'conv-a',
      filters: { from: null, to: null, agent: null, configured_model: null },
      totals: {
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
      by_agent: [],
    });
    mocks.getActivityItem.mockImplementation(async (_conversationId: string, messageId: string) => ({
      ...activityItem(1, '短预览'),
      message_id: messageId,
      content: '完整内容'.repeat(200),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('渲染 Agent 状态、活动与任务', async () => {
    mocks.listActivity.mockResolvedValue(activityPage([activityItem(1, '第一条活动')]));

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText('第一条活动')).toBeTruthy();
    expect(screen.getByText('Dashboard 验收')).toBeTruthy();
    expect(screen.getByText(/已送达/)).toBeTruthy();
  });

  it('增量刷新只追加新增活动，重复序号不会重复显示', async () => {
    mocks.listActivity
      .mockResolvedValueOnce(activityPage([activityItem(1, '活动甲'), activityItem(2, '活动乙')]))
      .mockResolvedValue(activityPage([activityItem(2, '活动乙'), activityItem(3, '活动丙')]));

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(screen.getByText('活动甲')).toBeTruthy();
    expect(screen.getAllByText('活动乙')).toHaveLength(1);
    expect(screen.getByText('活动丙')).toBeTruthy();
  });

  it('游标只前进到实际收到的最大 seq，不跳到 head_seq', async () => {
    mocks.listActivity
      .mockResolvedValueOnce({
        items: [activityItem(1, '活动甲')],
        head_seq: 900,
        has_more: false,
        limit: 50,
      })
      .mockResolvedValue(activityPage([]));

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    const tickCall = mocks.listActivity.mock.calls.at(-1);
    expect(tickCall?.[1]).toMatchObject({ afterSeq: 1, limit: 100 });
  });

  it('点击任务打开详情并展示结果预览', async () => {
    mocks.listActivity.mockResolvedValue(activityPage([]));

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('Dashboard 验收'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('检查迁移文件')).toBeTruthy();
    expect(screen.getByText('结果内容')).toBeTruthy();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith('conv-a', 'task-1');
    expect(
      screen.getByRole('tab', { name: '信息' }).getAttribute('aria-selected'),
    ).toBe('true');

    fireEvent.click(screen.getByText('Dashboard 验收'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('结果内容')).toBeNull();
    expect(screen.getByRole('tab', { name: '信息' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('点击活动行弹出完整内容，Esc 关闭', async () => {
    mocks.listActivity.mockResolvedValue(activityPage([activityItem(1, '短预览')]));

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('短预览'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/完整内容/)).toBeTruthy();
    expect(mocks.getActivityItem).toHaveBeenCalledWith('conv-a', 'm-1');

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有摘要时列表优先展示摘要', async () => {
    mocks.listActivity.mockResolvedValue(
      activityPage([
        {
          ...activityItem(1, 'file_change'),
          kind: 'tool_call',
          metadata: { tool: 'file_change', summary: '新增 tests/fixtures/fake.txt' },
        },
      ]),
    );

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/新增 tests\/fixtures\/fake\.txt/)).toBeTruthy();
  });

  it('详情弹窗显示摘要与 Agent 原始输出提示', async () => {
    mocks.listActivity.mockResolvedValue(
      activityPage([
        {
          ...activityItem(1, 'file_change'),
          kind: 'tool_call',
          metadata: { tool: 'file_change', summary: '新增 a.ts' },
        },
      ]),
    );

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('新增 a.ts'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('摘要')).toBeTruthy();
    expect(screen.getByText('Agent 原始输出')).toBeTruthy();
    expect(screen.getByText(/未脱敏/)).toBeTruthy();
  });

  it('未知活动类型不会被丢弃', async () => {
    mocks.listActivity.mockResolvedValue(
      activityPage([{ ...activityItem(1, '未知事件预览'), kind: 'file_change' }]),
    );

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('file_change')).toBeTruthy();
    expect(screen.getByText('未知事件预览')).toBeTruthy();
  });
});
