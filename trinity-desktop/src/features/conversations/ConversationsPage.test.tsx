import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConversationControlBar } from '../../components/ConversationControlBar';
import { ConversationControlsProvider } from '../../hooks/useConversationControls';
import { ConversationsPage } from './ConversationsPage';

const mocks = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listMessages: vi.fn(),
  createConversation: vi.fn(),
  sendTurn: vi.fn(),
  getAgent: vi.fn(),
  bindAgent: vi.fn(),
  setAgentParticipating: vi.fn(),
  unbindAgent: vi.fn(),
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  getConversationUsage: vi.fn(),
  sendGroupMessage: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
}));

vi.mock('../../hooks/useCoreStatus', () => ({
  useCore: () => ({
    state: 'connected',
    lastCheckedAt: 0,
    lastError: null,
    refresh: async () => true,
  }),
}));

vi.mock('../../services/core-api', () => ({
  listConversations: mocks.listConversations,
  listMessages: mocks.listMessages,
  createConversation: mocks.createConversation,
  sendTurn: mocks.sendTurn,
  getAgent: mocks.getAgent,
  bindAgent: mocks.bindAgent,
  setAgentParticipating: mocks.setAgentParticipating,
  unbindAgent: mocks.unbindAgent,
  listApprovals: mocks.listApprovals,
  decideApproval: mocks.decideApproval,
  getConversationUsage: mocks.getConversationUsage,
  sendGroupMessage: mocks.sendGroupMessage,
  listWorkspaces: mocks.listWorkspaces,
  createWorkspace: mocks.createWorkspace,
}));

const conversationA = {
  id: 'conv-a',
  project_id: null,
  title: '对话 A',
  status: 'active' as const,
  created_at: '2026-11-19T00:00:00.000Z',
  updated_at: '2026-11-19T00:00:00.000Z',
};

const conversationB = { ...conversationA, id: 'conv-b', title: '对话 B' };

const DISPLAY: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

interface BindingSpec {
  agent: string;
  active?: boolean;
  participating?: boolean;
  status?: string;
  native?: string | null;
  cwd?: string | null;
}

function agentState(bindings: BindingSpec[], activeAgent: string | null = null): unknown {
  return {
    agent: activeAgent,
    active_agent: activeAgent,
    available: ['claude', 'codex', 'deepseek'],
    bindings: bindings.map((binding) => ({
      agent: binding.agent,
      display_name: DISPLAY[binding.agent] ?? binding.agent,
      active: binding.active ?? false,
      participating: binding.participating ?? true,
      status: binding.status ?? 'idle',
      native_session_id: binding.native ?? null,
      cwd: binding.cwd ?? null,
      model: null,
      last_seen_at: null,
    })),
    warning: null,
  };
}

function message(id: string, conversationId: string, content: string) {
  return {
    id,
    conversation_id: conversationId,
    sender_kind: 'user' as const,
    sender_id: null,
    message_type: 'user_message' as const,
    content,
    metadata_json: null,
    parent_message_id: null,
    created_at: '2026-11-19T00:00:00.000Z',
  };
}

type Resolver = (value: { items: unknown[]; total: number; limit: number; offset: number }) => void;

/** The first call (limit 1) returns the total; the page call resolves when the test says so. */
function installDeferredMessageLoads(): Map<string, Resolver> {
  const pending = new Map<string, Resolver>();

  mocks.listMessages.mockImplementation(
    (conversationId: string, params: { limit?: number } = {}) => {
      if (params.limit === 1) {
        return Promise.resolve({ items: [], total: 1, limit: 1, offset: 0 });
      }
      return new Promise((resolve) => {
        pending.set(conversationId, resolve as Resolver);
      });
    },
  );

  return pending;
}

afterEach(() => {
  cleanup();
});

/** The page and the sidebar bar share one controls provider, as in the app. */
function renderPage() {
  return render(
    <ConversationControlsProvider>
      <ConversationsPage />
      <ConversationControlBar />
    </ConversationControlsProvider>,
  );
}

describe('ConversationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listConversations.mockResolvedValue({
      items: [conversationA, conversationB],
      total: 2,
      limit: 100,
      offset: 0,
    });
    mocks.getAgent.mockResolvedValue(agentState([]));
    mocks.listApprovals.mockResolvedValue({ items: [] });
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.listWorkspaces.mockResolvedValue({ items: [], default_root: 'E:\\Trinity\\workspaces' });
    mocks.createWorkspace.mockResolvedValue({
      id: 'ws-new',
      name: '新建工作区',
      path: 'E:\\Trinity\\workspaces\\claude',
      created_at: '2026-11-21T00:00:00.000Z',
      updated_at: '2026-11-21T00:00:00.000Z',
    });
    mocks.getConversationUsage.mockResolvedValue({
      conversation_id: 'conv-a',
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
      items: [],
      limit: 50,
      offset: 0,
    });
  });

  it('switching conversations discards a late response from the previous one', async () => {
    const pending = installDeferredMessageLoads();

    renderPage();

    // The first conversation is selected automatically and its load stays pending.
    await waitFor(() => expect(pending.has('conv-a')).toBe(true));

    fireEvent.click(screen.getByText('对话 B'));
    await waitFor(() => expect(pending.has('conv-b')).toBe(true));

    // The newer conversation resolves first.
    pending.get('conv-b')?.({ items: [message('m-b', 'conv-b', '来自对话 B 的消息')], total: 1, limit: 50, offset: 0 });
    await waitFor(() => expect(screen.getByText('来自对话 B 的消息')).toBeTruthy());

    // The older request resolves afterwards and must be ignored.
    pending.get('conv-a')?.({ items: [message('m-a', 'conv-a', '来自对话 A 的消息')], total: 1, limit: 50, offset: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText('来自对话 A 的消息')).toBeNull();
    expect(screen.getByText('来自对话 B 的消息')).toBeTruthy();
  });

  it('a rapid double Enter sends only one message', async () => {
    mocks.listMessages.mockImplementation(
      (_conversationId: string, params: { limit?: number } = {}) =>
        Promise.resolve(
          params.limit === 1
            ? { items: [], total: 0, limit: 1, offset: 0 }
            : { items: [], total: 0, limit: 50, offset: 0 },
        ),
    );
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.sendTurn.mockResolvedValue({
      message: message('m-1', 'conv-a', '只应发送一次'),
      turn_id: null,
      agent: null,
    });

    renderPage();

    await waitFor(() => expect(screen.getAllByText('对话 A').length).toBeGreaterThan(0));
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    const textarea = screen.getByPlaceholderText('输入消息…');
    fireEvent.change(textarea, { target: { value: '只应发送一次' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mocks.sendTurn).toHaveBeenCalledTimes(1));
  });

  it('lists every harness and marks the active one', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true, native: 'sid-claude' },
          { agent: 'codex', native: 'sid-codex' },
        ],
        'claude',
      ),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Claude Code · 当前使用' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Codex · 已加入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'DSH · 未连接' })).toBeTruthy();
  });

  it('a bound but switched-out agent joins again without stealing current', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true, native: 'sid-claude' },
          { agent: 'codex', participating: false, native: 'sid-codex' },
        ],
        'claude',
      ),
    );
    mocks.setAgentParticipating.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true, native: 'sid-claude' },
          { agent: 'codex', participating: true, native: 'sid-codex' },
        ],
        'claude',
      ),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Codex · 已绑定' }));

    await waitFor(() =>
      expect(mocks.setAgentParticipating).toHaveBeenCalledWith('conv-a', 'codex', true),
    );
    expect(mocks.bindAgent).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Codex · 已加入' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Claude Code · 当前使用' })).toBeTruthy();
  });

  it('an unavailable agent surfaces an error instead of pretending to bind', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.bindAgent.mockRejectedValue({
      code: 'harness_unavailable',
      message: 'Codex is not available: Could not find a usable "codex" executable.',
      status: 422,
      isApiError: true,
    });

    renderPage();

    // Binding is now a two-step action: the workspace is chosen first.
    fireEvent.click(await screen.findByRole('button', { name: 'Codex · 未连接' }));

    await screen.findByRole('dialog', { name: 'Codex 的工作区' });
    await waitFor(() =>
      expect((screen.getByLabelText('工作区目录') as HTMLInputElement).value).not.toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: '新建并选择' }));

    await waitFor(() =>
      expect(screen.getAllByText(/Codex is not available/).length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('button', { name: 'Codex · 未连接' })).toBeTruthy();
  });

  it('a started turn keeps polling until the agent stops running', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 1, limit: 50, offset: 0 });
    mocks.sendTurn.mockResolvedValue({
      message: message('m-1', 'conv-a', '你好'),
      turn_id: 'turn-1',
      agent: 'claude',
    });

    let calls = 0;
    mocks.getAgent.mockImplementation(async () => {
      calls += 1;
      return agentState(
        [{ agent: 'claude', active: true, status: calls === 2 ? 'running' : 'idle' }],
        'claude',
      );
    });

    renderPage();

    // Sending now depends on the participating agent, so wait for it to load.
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    const textarea = await screen.findByPlaceholderText('输入消息…');
    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mocks.sendTurn).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(mocks.getAgent.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 8000,
    });
  }, 15000);

  it('a decision that never reached the agent is reported, not silently dropped', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true, status: 'running' }], 'claude'),
    );
    mocks.listApprovals.mockResolvedValue({
      items: [
        {
          id: 'ap-1',
          conversation_id: 'conv-a',
          agent: 'claude',
          kind: 'tool_approval',
          tool_name: 'Write',
          tool_use_id: 'tu-1',
          payload: { tool_name: 'Write', detail: 'a.txt', input_keys: ['file_path'] },
          status: 'pending',
          delivery_status: 'pending',
          created_at: '2026-11-19T00:00:00.000Z',
          decided_at: null,
          expires_at: null,
        },
      ],
    });
    mocks.decideApproval.mockResolvedValue({
      id: 'ap-1',
      conversation_id: 'conv-a',
      agent: 'claude',
      kind: 'tool_approval',
      tool_name: 'Write',
      tool_use_id: 'tu-1',
      payload: {},
      status: 'approved',
      delivery_status: 'failed',
      created_at: '2026-11-19T00:00:00.000Z',
      decided_at: '2026-11-19T00:00:01.000Z',
      expires_at: null,
    });

    renderPage();

    fireEvent.click(await screen.findByText('批准'));

    await waitFor(() => expect(mocks.decideApproval).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/没能送达 Agent/)).toBeTruthy();
  }, 15000);

  it('提及 Agent 时走群聊接口，而不是单 Agent 回合', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }, { agent: 'codex' }], 'claude'),
    );
    mocks.sendGroupMessage.mockResolvedValue({ group_turn_id: 'group-1', targets: ['claude'] });

    renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '@Claude 你好' },
    });
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() =>
      expect(mocks.sendGroupMessage).toHaveBeenCalledWith('conv-a', '@Claude 你好'),
    );
    expect(mocks.sendTurn).not.toHaveBeenCalled();
    expect(await screen.findByText(/本轮群聊/)).toBeTruthy();
  }, 15000);

  it('@提及菜单只列出已绑定的 Agent，点击插入提及', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }, { agent: 'codex' }], 'claude'),
    );

    const view = renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    fireEvent.click(screen.getByText('＋ @提及 Agent'));

    const menu = view.container.querySelector('.mention-menu');
    expect(menu).toBeTruthy();

    const items = Array.from(menu!.querySelectorAll('.mention-item')) as HTMLElement[];
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('所有 Agent');
    fireEvent.click(items[1]!);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('@Claude ');
  });

  it('「所有 Agent」一次写入全部已绑定的提及', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true },
          { agent: 'codex' },
          { agent: 'deepseek' },
        ],
        'claude',
      ),
    );

    const view = renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    fireEvent.click(screen.getByText('＋ @提及 Agent'));

    const all = screen.getByText('所有 Agent').closest('button') as HTMLElement;
    expect(all.querySelector('.agent-avatar.is-trinity')).toBeTruthy();
    fireEvent.click(all);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      '@Claude @Codex @DSH ',
    );
    expect(view.container.querySelector('.mention-menu')).toBeNull();
  });

  it('消息头像使用各家官方标记', async () => {
    mocks.listMessages.mockResolvedValue({
      items: [
        {
          id: 'm-brands',
          conversation_id: 'conv-a',
          sender_kind: 'agent',
          sender_id: 'Claude Code',
          message_type: 'agent_final',
          content: '完成。',
          metadata_json: null,
          parent_message_id: null,
          created_at: '2026-11-19T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const view = renderPage();

    await waitFor(() =>
      expect(view.container.querySelector('.agent-avatar.is-claude svg path')).toBeTruthy(),
    );
  });

  it('Agent 消息按发送者显示头像与名称', async () => {
    mocks.listMessages.mockResolvedValue({
      items: [
        {
          id: 'm-agent',
          conversation_id: 'conv-a',
          sender_kind: 'agent',
          sender_id: 'Codex',
          message_type: 'agent_final',
          content: '完成。',
          metadata_json: null,
          parent_message_id: null,
          created_at: '2026-11-19T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const view = renderPage();

    await waitFor(() =>
      expect(view.container.querySelector('.agent-avatar.is-codex')).toBeTruthy(),
    );
    expect(view.container.querySelector('.msg.is-codex')).toBeTruthy();
  });

  it('发送时先显示用户消息，服务端返回后不重复', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );

    let resolveSend: (value: unknown) => void = () => {};
    mocks.sendTurn.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }),
    );

    renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    const textarea = screen.getByPlaceholderText('输入消息…');
    fireEvent.change(textarea, { target: { value: '立即出现' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Visible before Core answers.
    expect(await screen.findByText('立即出现')).toBeTruthy();
    expect(mocks.sendTurn).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('立即出现')).toHaveLength(1);

    const serverMessage = message('m-1', 'conv-a', '立即出现');
    mocks.listMessages.mockResolvedValue({
      items: [serverMessage],
      total: 1,
      limit: 50,
      offset: 0,
    });
    resolveSend({ message: serverMessage, turn_id: null, agent: 'claude' });

    await waitFor(() => expect(screen.getAllByText('立即出现')).toHaveLength(1));
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('发送后的第一次轮询立即执行，不等待固定间隔', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.sendTurn.mockResolvedValue({
      message: message('m-1', 'conv-a', '你好'),
      turn_id: 'turn-1',
      agent: 'claude',
    });

    renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    const baseline = mocks.getAgent.mock.calls.length;
    const textarea = screen.getByPlaceholderText('输入消息…');
    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(
      () => expect(mocks.getAgent.mock.calls.length).toBeGreaterThan(baseline),
      { timeout: 500 },
    );
  });

  it('发送失败时撤回乐观消息并保留输入内容', async () => {
    mocks.listMessages.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.sendTurn.mockRejectedValue({
      code: 'network_error',
      message: '无法连接 Trinity Core（127.0.0.1:3211（测试））',
      status: 0,
      isApiError: true,
    });

    const view = renderPage();
    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });

    const textarea = screen.getByPlaceholderText('输入消息…');
    fireEvent.change(textarea, { target: { value: '不会丢' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      const bubbles = [...view.container.querySelectorAll('.bubble')].map(
        (node) => node.textContent,
      );
      expect(bubbles).not.toContain('不会丢');
    });
    expect((textarea as HTMLTextAreaElement).value).toBe('不会丢');
    expect((await screen.findAllByText(/无法连接 Trinity Core/)).length).toBeGreaterThan(0);
  });

  it('发送模式默认团队，并且按对话分别记住', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true },
          { agent: 'codex' },
          { agent: 'deepseek' },
        ],
        'claude',
      ),
    );

    renderPage();

    const team = await screen.findByRole('button', { name: '团队' });
    expect(team.className).toContain('btn-primary');

    fireEvent.click(screen.getByRole('button', { name: 'Codex 执行' }));

    await waitFor(() => {
      expect(localStorage.getItem('trinity.sendMode:conv-a')).toBe('codex');
      expect(screen.getByRole('button', { name: 'Codex 执行' }).className).toContain(
        'btn-primary',
      );
    });

    // Another conversation keeps its own choice: team, not codex.
    fireEvent.click(screen.getByText('对话 B'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '团队' }).className).toContain('btn-primary');
    });
    expect(screen.getByRole('button', { name: 'Codex 执行' }).className).not.toContain(
      'btn-primary',
    );

    // Coming back restores the first conversation's choice.
    fireEvent.click(screen.getByText('对话 A'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Codex 执行' }).className).toContain(
        'btn-primary',
      );
    });
  });

  it('切换对话后，点亮的 Agent 按该对话自己的选择显示', async () => {
    mocks.getAgent.mockImplementation((conversationId: string) =>
      Promise.resolve(
        conversationId === 'conv-b'
          ? agentState(
              [
                { agent: 'claude', active: true },
                { agent: 'codex', participating: false },
              ],
              'claude',
            )
          : agentState(
              [
                { agent: 'claude', active: true },
                { agent: 'codex', participating: true },
              ],
              'claude',
            ),
      ),
    );

    renderPage();

    expect(await screen.findByRole('button', { name: 'Codex · 已加入' })).toBeTruthy();

    fireEvent.click(screen.getByText('对话 B'));

    expect(await screen.findByRole('button', { name: 'Codex · 已绑定' })).toBeTruthy();

    fireEvent.click(screen.getByText('对话 A'));

    expect(await screen.findByRole('button', { name: 'Codex · 已加入' })).toBeTruthy();
  });

  it('已绑定的 Agent 在控制栏显示自己的工作区', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true, cwd: 'E:\\ws\\claude' }], 'claude'),
    );

    renderPage();

    await screen.findByRole('button', { name: 'Claude Code · 当前使用' });
    expect(screen.getByText('E:\\ws\\claude')).toBeTruthy();
  });

  it('未绑定的 Agent 先选工作区，再带着目录绑定', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.listWorkspaces.mockResolvedValue({
      items: [
        {
          id: 'ws-1',
          name: 'Codex 工作区',
          path: 'E:\\ws\\codex',
          created_at: '2026-11-21T00:00:00.000Z',
          updated_at: '2026-11-21T00:00:00.000Z',
        },
      ],
      default_root: 'E:\\Trinity\\workspaces',
    });
    mocks.bindAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true },
          { agent: 'codex', cwd: 'E:\\ws\\codex' },
        ],
        'claude',
      ),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Codex · 未连接' }));
    await screen.findByRole('dialog', { name: 'Codex 的工作区' });

    // The dialog opens before its workspace list resolves; wait for the row.
    const row = await screen.findByText('Codex 工作区');
    fireEvent.click(row.closest('button') as HTMLElement);

    await waitFor(() =>
      expect(mocks.bindAgent).toHaveBeenCalledWith('conv-a', {
        agent: 'codex',
        cwd: 'E:\\ws\\codex',
        active: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('E:\\ws\\codex')).toBeTruthy();
  });

  it('可以新建工作区并直接绑定', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.createWorkspace.mockResolvedValue({
      id: 'ws-9',
      name: '项目一',
      path: 'E:\\work\\proj1',
      created_at: '2026-11-21T00:00:00.000Z',
      updated_at: '2026-11-21T00:00:00.000Z',
    });
    mocks.bindAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true },
          { agent: 'codex', cwd: 'E:\\work\\proj1' },
        ],
        'claude',
      ),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Codex · 未连接' }));
    await screen.findByRole('dialog', { name: 'Codex 的工作区' });

    await waitFor(() =>
      expect((screen.getByLabelText('工作区目录') as HTMLInputElement).value).not.toBe(''),
    );

    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '项目一' } });
    fireEvent.change(screen.getByLabelText('工作区目录'), { target: { value: 'E:\\work\\proj1' } });
    fireEvent.click(screen.getByRole('button', { name: '新建并选择' }));

    await waitFor(() =>
      expect(mocks.createWorkspace).toHaveBeenCalledWith({
        name: '项目一',
        path: 'E:\\work\\proj1',
      }),
    );
    await waitFor(() =>
      expect(mocks.bindAgent).toHaveBeenCalledWith('conv-a', {
        agent: 'codex',
        cwd: 'E:\\work\\proj1',
        active: false,
      }),
    );
  });

  it('有默认工作区时，未绑定的 Agent 直接加入，不再弹选择框', async () => {
    mocks.getAgent.mockResolvedValue(
      agentState([{ agent: 'claude', active: true }], 'claude'),
    );
    mocks.listWorkspaces.mockResolvedValue({
      items: [
        {
          id: 'ws-codex',
          name: 'Codex 工作区',
          path: 'E:\\Trinity\\workspaces\\codex',
          created_at: '2026-11-21T00:00:00.000Z',
          updated_at: '2026-11-21T00:00:00.000Z',
        },
      ],
      default_root: 'E:\\Trinity\\workspaces',
    });
    mocks.bindAgent.mockResolvedValue(
      agentState(
        [
          { agent: 'claude', active: true },
          { agent: 'codex', cwd: 'E:\\Trinity\\workspaces\\codex' },
        ],
        'claude',
      ),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Codex · 未连接' }));

    await waitFor(() =>
      expect(mocks.bindAgent).toHaveBeenCalledWith('conv-a', {
        agent: 'codex',
        cwd: 'E:\\Trinity\\workspaces\\codex',
        active: false,
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('E:\\Trinity\\workspaces\\codex')).toBeTruthy();
  });
});
