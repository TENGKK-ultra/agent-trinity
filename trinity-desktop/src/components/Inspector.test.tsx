import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationControlsProvider,
  useConversationControls,
} from '../hooks/useConversationControls';
import { InspectorProvider, useInspector } from '../hooks/useInspector';
import { Inspector } from './Inspector';

const mocks = vi.hoisted(() => ({
  getTaskDetail: vi.fn(),
  getTaskUsage: vi.fn(),
  listAgentDirectory: vi.fn(),
  getAgent: vi.fn(),
  setConversationPermission: vi.fn(),
}));

vi.mock('../services/core-api', () => ({
  getTaskDetail: mocks.getTaskDetail,
  getTaskUsage: mocks.getTaskUsage,
  listAgentDirectory: mocks.listAgentDirectory,
  getAgent: mocks.getAgent,
  setConversationPermission: mocks.setConversationPermission,
}));

vi.mock('../hooks/useCoreStatus', () => ({
  useCore: () => ({ state: 'connected', lastCheckedAt: null, lastError: null }),
}));

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
  title: '面板验收',
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

function Picker() {
  const { toggleTask } = useInspector();

  return (
    <button type="button" onClick={() => toggleTask(task)}>
      pick
    </button>
  );
}

function panels() {
  return {
    info: screen.getByRole('tab', { name: '信息' }),
    settings: screen.getByRole('tab', { name: '设置' }),
    todo: screen.getByRole('tab', { name: '待办' }),
  };
}

function ConversationPicker() {
  const { setConversationId } = useConversationControls();

  useEffect(() => {
    setConversationId('conv-a');
  }, [setConversationId]);

  return null;
}

describe('Inspector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgent.mockResolvedValue({
      agent: null,
      active_agent: null,
      available: [],
      bindings: [],
    });
    mocks.listAgentDirectory.mockResolvedValue({
      items: [
        {
          agent: 'claude',
          display_name: 'Claude Code',
          bound_conversations: 1,
          participating_conversations: 1,
          active_conversations: 1,
          running_conversations: 0,
          quarantined_conversations: 0,
          last_seen_at: null,
          cwd: null,
          model: null,
        },
        {
          agent: 'codex',
          display_name: 'Codex',
          bound_conversations: 0,
          participating_conversations: 0,
          active_conversations: 0,
          running_conversations: 0,
          quarantined_conversations: 0,
          last_seen_at: null,
          cwd: null,
          model: null,
        },
        {
          agent: 'deepseek',
          display_name: 'DeepSeek Harness',
          bound_conversations: 0,
          participating_conversations: 0,
          active_conversations: 0,
          running_conversations: 0,
          quarantined_conversations: 0,
          last_seen_at: null,
          cwd: null,
          model: null,
        },
      ],
    });
    mocks.getTaskDetail.mockResolvedValue({
      task,
      result: { message_id: 'm-result', content_preview: '结果内容', created_at: task.created_at },
    });
    mocks.getTaskUsage.mockResolvedValue({
      task_id: task.id,
      conversation_id: task.conversation_id,
      filters: { from: null, to: null, agent: null, configured_model: null },
      totals: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 12,
        cost_usd: null,
      },
      by_agent: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('默认停在信息页：后端、Agent、项目与上下文在同一页', async () => {
    render(
      <InspectorProvider>
        <ConversationControlsProvider>
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    expect(panels().info.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('后端')).toBeTruthy();
    expect(screen.getByText('当前项目')).toBeTruthy();
    expect(screen.getByText('上下文')).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Claude Code')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '待办' }));

    expect(panels().todo.getAttribute('aria-selected')).toBe('true');
  });

  it('方向按钮在信息、权限与待办之间翻动，到边界后禁用', async () => {
    render(
      <InspectorProvider>
        <ConversationControlsProvider>
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().settings.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().todo.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().settings.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().info.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    expect(screen.getByRole('button', { name: '上一页' }).hasAttribute('disabled')).toBe(true);
  });

  it('权限页可以把对话切换为接受编辑', async () => {
    mocks.setConversationPermission.mockResolvedValue({
      agent: 'claude',
      active_agent: 'claude',
      available: ['claude'],
      bindings: [
        {
          agent: 'claude',
          display_name: 'Claude Code',
          active: true,
          participating: true,
          status: 'idle',
          native_session_id: null,
          cwd: null,
          model: null,
          permission_mode: 'acceptEdits',
          last_seen_at: null,
        },
      ],
    });

    render(
      <InspectorProvider>
        <ConversationControlsProvider>
          <ConversationPicker />
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: /权限.*手动/ }));
    fireEvent.click(screen.getByRole('button', { name: /接受编辑/ }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.setConversationPermission).toHaveBeenCalledWith('conv-a', 'acceptEdits');
  });

  it('选中任务时详情出现在信息页，再次选中同一个任务收起详情', async () => {
    render(
      <InspectorProvider>
        <ConversationControlsProvider>
          <Picker />
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    fireEvent.click(screen.getByText('pick'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().info.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('任务详情')).toBeTruthy();
    expect(mocks.getTaskDetail).toHaveBeenCalledWith('conv-a', 'task-1');
    expect(screen.getByText('检查迁移文件')).toBeTruthy();
    expect(screen.getByText('结果内容')).toBeTruthy();

    fireEvent.click(screen.getByText('pick'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().info.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('结果内容')).toBeNull();
    expect(screen.queryByText('任务详情')).toBeNull();
  });

  it('页面卸载后侧边栏状态仍保留', async () => {
    const view = render(
      <InspectorProvider>
        <ConversationControlsProvider>
          <Picker />
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    fireEvent.click(screen.getByText('pick'));
    await act(async () => {
      await Promise.resolve();
    });

    // The page that opened the task is gone; the provider above it is not.
    view.rerender(
      <InspectorProvider>
        <ConversationControlsProvider>
          <Inspector />
        </ConversationControlsProvider>
      </InspectorProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(panels().info.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('结果内容')).toBeTruthy();
  });
});
