import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, MessagesSquare, Plus, Send } from 'lucide-react';
import { AgentMark } from '../../components/AgentMark';
import { EmptyState } from '../../components/EmptyState';
import { useConversationControls } from '../../hooks/useConversationControls';
import { useCore } from '../../hooks/useCoreStatus';
import { isApiError } from '../../services/api-client';
import {
  bindAgent,
  createConversation,
  decideApproval,
  getConversationUsage,
  listApprovals,
  listConversations,
  listMessages,
  sendGroupMessage,
  sendTurn,
  updateConversation,
} from '../../services/core-api';
import type {
  AgentKind,
  ApprovalDto,
  ConversationDto,
  MessageDto,
  MessageType,
  UsageConversationDto,
} from '../../services/core-api';
import { COST_NOTE, formatCost, formatTokens } from '../usage/format';
import { ApprovalCard } from './ApprovalCard';
import { AGENT_BY_SENDER, AGENT_LABEL, AGENT_ORDER, MENTION_NAME } from './agents';
import { planSend } from './send-routing';

const PAGE_SIZE = 50;
const TURN_POLL_MS = 700;
const TURN_POLL_DEADLINE_MS = 6 * 60 * 1000;


const TYPE_LABEL: Record<MessageType, string> = {
  user_message: '用户',
  agent_message: '回复',
  agent_final: '最终回复',
  tool_call: '工具调用',
  tool_result: '工具结果',
  system_event: '系统事件',
  task_status: '任务状态',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function ConversationsPage({
  initialConversationId = null,
}: {
  initialConversationId?: string | null;
} = {}) {
  const { state } = useCore();
  const connected = state === 'connected';

  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  // 深链指定的对话，等列表加载完再消费
  const pendingId = useRef<string | null>(initialConversationId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedOffset, setLoadedOffset] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const {
    agentState,
    applyAgentState,
    refreshAgent,
    sendMode,
    setConversationId,
    mentionRef,
  } = useConversationControls();

  const [agentBusy, setAgentBusy] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalDto[]>([]);
  const [conversationUsage, setConversationUsage] = useState<UsageConversationDto | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [groupTargets, setGroupTargets] = useState<AgentKind[]>([]);
  const [menu, setMenu] = useState<{
    id: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  // Reading history must not be interrupted by a poll that repaints the list.
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const activeIdRef = useRef<string | null>(null);
  // Bumped on every conversation load so a late response cannot overwrite a newer one.
  const loadSeq = useRef(0);
  // A ref (not state) so two keydowns in the same tick cannot both pass the guard.
  const sendingRef = useRef(false);

  const describeError = (value: unknown): string => {
    if (!isApiError(value)) return '操作失败，请稍后重试';

    if (value.code === 'no_bound_target') return '被提及的 Agent 还没有绑定到这个对话';
    if (value.code === 'no_target_agent') return '这个对话还没有绑定任何 Agent';
    if (value.code === 'workspace_missing') {
      return '这个 Agent 还没有工作区，请先在右侧栏「本轮设置」里选择';
    }

    return value.message;
  };

  const insertMention = useCallback((kind: AgentKind) => {
    setDraft((current) => {
      const separator = current === '' || current.endsWith(' ') ? '' : ' ';
      return `${current}${separator}@${MENTION_NAME[kind]} `;
    });
    setMentionOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // "Every agent" is a convenience, not a new protocol: it writes the mentions
  // of the agents bound here, and Core routes exactly as it would for typing.
  const insertAllMentions = useCallback(() => {
    const bound = AGENT_ORDER.filter((kind) =>
      (agentState?.bindings ?? []).some((binding) => binding.agent === kind),
    );

    if (bound.length === 0) return;

    setDraft((current) => {
      const separator = current === '' || current.endsWith(' ') ? '' : ' ';
      const mentions = bound.map((kind) => `@${MENTION_NAME[kind]}`).join(' ');
      return `${current}${separator}${mentions} `;
    });
    setMentionOpen(false);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [agentState]);

  // The sidebar's agent rows live in another component; hand them the page's
  // @-insertion so right-click still lands in this draft.
  useEffect(() => {
    mentionRef.current = insertMention;

    return () => {
      mentionRef.current = null;
    };
  }, [insertMention, mentionRef]);

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    try {
      const page = await listConversations({ limit: 100, sort: 'updated', order: 'desc' });
      setConversations(page.items);
      setError(null);
      setActiveId((current) => {
        // 从搜索跳进来时，先打开它指定的那一条（只消费一次）
        const wanted = pendingId.current;
        if (wanted !== null && page.items.some((item) => item.id === wanted)) {
          pendingId.current = null;
          return wanted;
        }
        if (current && page.items.some((item) => item.id === current)) return current;
        return page.items[0]?.id ?? null;
      });
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const seq = ++loadSeq.current;
    setLoadingMessages(true);
    try {
      const head = await listMessages(conversationId, { limit: 1, offset: 0 });
      if (seq !== loadSeq.current) return;

      const offset = Math.max(0, head.total - PAGE_SIZE);
      const page = await listMessages(conversationId, { limit: PAGE_SIZE, offset });
      if (seq !== loadSeq.current) return;

      setMessages(page.items);
      setTotal(page.total);
      setLoadedOffset(offset);
      setError(null);

      // Only follow new messages when the reader is already at the end.
      if (stickRef.current) {
        window.requestAnimationFrame(() => {
          const node = threadRef.current;
          if (node) node.scrollTop = node.scrollHeight;
        });
      }
    } catch (caught) {
      if (seq !== loadSeq.current) return;
      setMessages([]);
      setTotal(0);
      setError(describeError(caught));
    } finally {
      if (seq === loadSeq.current) setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) {
      setConversations([]);
      setActiveId(null);
      setMessages([]);
      setTotal(0);
      return;
    }
    void loadConversations();
  }, [connected, loadConversations]);

  useEffect(() => {
    activeIdRef.current = activeId;
    setApprovals([]);
    stickRef.current = true;
    setAtBottom(true);

    if (!activeId) {
      setMessages([]);
      setTotal(0);
      return;
    }

    void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // The sidebar renders the round's switches; it needs to know which
  // conversation is on screen, and it must go blank when this page is gone.
  useEffect(() => {
    setConversationId(activeId);
  }, [activeId, setConversationId]);

  useEffect(
    () => () => {
      setConversationId(null);
    },
    [setConversationId],
  );

  // A turn runs in the background on Core; poll until the agent reports it is
  // no longer running, so a slow answer still appears without a manual refresh.
  const pollTurn = useCallback(
    async (conversationId: string): Promise<void> => {
      setAgentBusy(true);
      const deadline = Date.now() + TURN_POLL_DEADLINE_MS;

      try {
        let first = true;

        while (Date.now() < deadline) {
          // The first check is immediate: the old fixed 1.5s wait was felt as
          // input lag even when the reply was already there.
          if (!first) await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
          first = false;

          if (activeIdRef.current !== conversationId) return;

          const binding = await refreshAgent(conversationId);

          // While the reader is scrolled up, a poll must not repaint the list:
          // it would both lose the older pages and drag the view to the end.
          if (stickRef.current) await loadMessages(conversationId);

          // A group round may move between agents, so any running binding keeps
          // the stream alive; waiting only on the active one would stop early.
          const running = binding?.bindings.find((row) => row.status === 'running') ?? null;
          if (!running) return;
        }
      } finally {
        setAgentBusy(false);
      }
    },
    [loadMessages, refreshAgent],
  );

  const activeStatus = agentState?.bindings.find((row) => row.active)?.status ?? null;
  const shouldPollApprovals = agentBusy || activeStatus === 'running' || approvals.length > 0;

  // Approvals are not part of the message stream, so they need their own poll.
  // It runs only while something can still raise one.
  useEffect(() => {
    if (!activeId || !connected) {
      setApprovals([]);
      return;
    }

    let cancelled = false;

    const tick = (): void => {
      void listApprovals(activeId, 'pending')
        .then((page) => {
          if (!cancelled) setApprovals(page.items);
        })
        .catch(() => {
          // A transient failure must not wipe a card the user is reading.
        });
    };

    tick();
    if (!shouldPollApprovals) return () => {
      cancelled = true;
    };

    const timer = setInterval(tick, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId, connected, shouldPollApprovals]);

  const handleDecision = async (
    approval: ApprovalDto,
    decision: 'approve' | 'deny',
    answers?: Record<string, string>,
  ): Promise<void> => {
    if (!activeId || decidingId) return;

    setDecidingId(approval.id);

    try {
      const updated = await decideApproval(activeId, approval.id, {
        agent: approval.agent,
        decision,
        answers,
      });
      setApprovals((current) => current.filter((item) => item.id !== approval.id));

      // The decision is recorded either way; the user still has to learn that
      // it never reached the agent.
      setError(
        updated.delivery_status === 'failed'
          ? '决定已记录，但没能送达 Agent —— 它可能已经结束，这次操作不会执行。'
          : null,
      );
    } catch (caught) {
      setError(describeError(caught));
      // No longer pending (timed out or answered elsewhere): drop the card. If
      // the failure was transient the next poll puts it back.
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    } finally {
      setDecidingId(null);
    }
  };

  const handleLoadOlder = async (): Promise<void> => {
    if (!activeId || loadedOffset === 0) return;
    const seq = loadSeq.current;
    const offset = Math.max(0, loadedOffset - PAGE_SIZE);
    try {
      const page = await listMessages(activeId, { limit: PAGE_SIZE, offset });
      if (seq !== loadSeq.current) return;
      const existing = new Set(messages.map((item) => item.id));
      const older = page.items.filter((item) => !existing.has(item.id));
      if (older.length > 0) setMessages((current) => [...older, ...current]);
      setLoadedOffset(offset);
      setTotal(page.total);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const handleRename = async (): Promise<void> => {
    if (renaming === null || renameBusy || renameValue.trim() === '') return;

    setRenameBusy(true);

    try {
      const updated = await updateConversation(renaming.id, { title: renameValue.trim() });
      setConversations((current) =>
        current.map((conversation) => (conversation.id === updated.id ? updated : conversation)),
      );
      setRenaming(null);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRenameBusy(false);
    }
  };

  const jumpToBottom = useCallback(async (): Promise<void> => {
    stickRef.current = true;
    setAtBottom(true);

    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    if (activeId !== null) await loadMessages(activeId);

    window.requestAnimationFrame(() => {
      const next = threadRef.current;
      if (next) next.scrollTop = next.scrollHeight;
    });
  }, [activeId, loadMessages]);

  const handleCreate = async (): Promise<void> => {
    try {
      const now = new Date();
      const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const created = await createConversation(`新对话 ${stamp}`);
      setConversations((current) => [created, ...current]);
      setActiveId(created.id);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const handleSend = async (): Promise<void> => {
    const content = draft.trim();
    if (!content || !activeId || sendingRef.current) return;

    const plan = planSend(content, agentState?.bindings ?? [], {
      mode: sendMode,
      dispatcher: 'codex',
    });

    if (plan.mode === 'none') {
      setError(plan.reason);
      return;
    }

    if (sendMode === 'team' && plan.mode === 'group') {
      setError('团队模式需要 Codex 在场并参与本轮；也可以切到「全员」或「Codex 执行」。');
      return;
    }

    const conversationId = activeId;
    const scrollToBottom = (): void => {
      stickRef.current = true;
      setAtBottom(true);
      window.requestAnimationFrame(() => {
        const node = threadRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
    };

    // Show the message at once; the server round-trip (and the Tauri HTTP
    // channel) must not be felt as input lag. The server message replaces this
    // one by id, and a reload replaces the whole list, so nothing duplicates.
    const optimistic: MessageDto = {
      id: `local-${crypto.randomUUID()}`,
      conversation_id: conversationId,
      sender_kind: 'user',
      sender_id: null,
      message_type: 'user_message',
      content,
      metadata_json: null,
      parent_message_id: null,
      created_at: new Date().toISOString(),
    };

    sendingRef.current = true;
    setSending(true);
    setMessages((current) => [...current, optimistic]);
    setTotal((current) => current + 1);
    setDraft('');
    setError(null);
    scrollToBottom();

    let sent = false;

    try {
      // One lit agent is an ordinary turn; two or three are one group round with
      // exactly those participants. A mention always wins and is routed by Core.
      if (plan.mode === 'solo') {
        const only = plan.targets[0];

        if (agentState?.active_agent !== only) {
          applyAgentState(await bindAgent(conversationId, { agent: only, active: true }));
        }

        const started = await sendTurn(conversationId, content);
        sent = true;

        setMessages((current) => {
          if (current.some((message) => message.id === started.message.id)) return current;

          const index = current.findIndex((message) => message.id === optimistic.id);

          if (index < 0) return [...current, started.message];

          const next = [...current];
          next[index] = started.message;
          return next;
        });
        void loadConversations();

        if (started.turn_id) {
          void pollTurn(conversationId);
        }

        return;
      }

      const started =
        plan.mode === 'mention'
          ? await sendGroupMessage(conversationId, content)
          : plan.mode === 'team'
            ? await sendGroupMessage(conversationId, content, {
                targets: plan.targets,
                mode: 'team',
                dispatcher: plan.dispatcher,
              })
            : await sendGroupMessage(conversationId, content, { targets: plan.targets });
      sent = true;

      setGroupTargets(started.targets as AgentKind[]);

      // Core persisted the user message; reload rather than echo it locally.
      await loadMessages(conversationId);
      scrollToBottom();
      void loadConversations();
      void pollTurn(conversationId);
    } catch (caught) {
      // Nothing reached Core: take the optimistic bubble back and keep the text.
      if (!sent) {
        setMessages((current) => current.filter((message) => message.id !== optimistic.id));
        setTotal((current) => Math.max(0, current - 1));
        setDraft((current) => (current === '' ? content : current));
      }

      setError(describeError(caught));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  useEffect(() => {
    if (activeId === null) {
      setConversationUsage(null);
      return;
    }

    let cancelled = false;

    getConversationUsage(activeId)
      .then((next) => {
        if (!cancelled) setConversationUsage(next);
      })
      .catch(() => {
        if (!cancelled) setConversationUsage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const active = conversations.find((item) => item.id === activeId) ?? null;
  const hasOlder = loadedOffset > 0;

  return (
    <section className="page">
      <div className="page-head page-head-compact">
        <div>
          <h1>对话</h1>
          <p>Trinity 自己的对话与消息记录</p>
        </div>
        <div className="grow" />
      </div>

      {error ? (
        <div className="banner banner-error">
          {error}
          <button className="btn btn-ghost" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="conv-layout">
        <div className="conv-list">
          <div className="conv-list-head">
            <button
              className="btn btn-primary"
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={!connected}
              onClick={() => void handleCreate()}
            >
              <Plus size={15} strokeWidth={1.8} />
              新建对话
            </button>
          </div>
          <div className="conv-list-body">
            {conversations.length === 0 ? (
              <EmptyState
                icon={MessagesSquare}
                title={connected ? '暂无对话' : '未连接 Core'}
                description={
                  connected
                    ? '点击上方「新建对话」开始。'
                    : '桌面端正在等待 Trinity Core 启动（127.0.0.1:3210）。'
                }
              />
            ) : (
              conversations.map((item) => (
                <button
                  key={item.id}
                  className="conv-item"
                  aria-selected={item.id === activeId}
                  onClick={() => setActiveId(item.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ id: item.id, title: item.title, x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className="t">{item.title}</div>
                  <div className="m">
                    {formatDay(item.updated_at)} · {item.status === 'archived' ? '已归档' : '进行中'}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="thread">
          <div className="thread-head">
            {/* The header keeps only the title and status; the per-round
                controls live in the bar above the input. */}
            <div className="thread-head-line">
              <h2 title={active ? active.title : undefined}>
                {active ? active.title : '未选择对话'}
              </h2>
              <div className="thread-status">
                {agentState?.warning ? (
                  <span className="chip chip-warning" title={agentState.warning}>
                    能力受限
                  </span>
                ) : null}
                {agentBusy ? <span className="chip">等待 Agent 回复…</span> : null}
                {groupTargets.length > 0 ? (
                  <span className="chip chip-group">
                    本轮群聊：{groupTargets.map((kind) => AGENT_LABEL[kind]).join(' → ')}
                  </span>
                ) : null}
                {active && total > 0 ? (
                  <span className="chip">
                    已加载 {messages.length} / 共 {total} 条
                  </span>
                ) : null}
                {loadingList ? <span className="chip">加载中…</span> : null}
              </div>
            </div>
          </div>

          <div
            className="thread-body"
            ref={threadRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              const next =
                node.scrollHeight - node.scrollTop - node.clientHeight < 80;

              stickRef.current = next;
              setAtBottom(next);
            }}
          >
            {!active ? (
              <EmptyState
                icon={MessagesSquare}
                title="还没有打开任何对话"
                description={
                  connected
                    ? '从左侧选择一个对话，或新建一个。'
                    : '连接 Trinity Core 后，这里会显示真实的对话与消息。'
                }
              />
            ) : loadingMessages && messages.length === 0 ? (
              <EmptyState icon={MessagesSquare} title="正在加载消息…" />
            ) : messages.length === 0 ? (
              <EmptyState
                icon={MessagesSquare}
                title="这个对话还没有消息"
                description="在下方输入内容并发送，消息会保存到 Trinity Core 的数据库。"
              />
            ) : (
              <>
                {hasOlder ? (
                  <button
                    className="btn btn-ghost"
                    style={{ alignSelf: 'center' }}
                    onClick={() => void handleLoadOlder()}
                  >
                    加载更早的消息
                  </button>
                ) : null}
                {messages.map((message) => {
                  const isUser = message.sender_kind === 'user';
                  const isStructured =
                    message.message_type === 'tool_call' || message.message_type === 'tool_result';
                  const isNotice = message.message_type === 'system_event';
                  const agentKind =
                    message.sender_kind === 'agent'
                      ? (AGENT_BY_SENDER[message.sender_id ?? ''] ?? null)
                      : null;

                  return (
                    <div
                      key={message.id}
                      className={`msg ${isUser ? 'user' : 'agent'}${
                        agentKind === null ? '' : ` is-${agentKind}`
                      }${isNotice ? ' is-notice' : ''}`}
                    >
                      {agentKind !== null ? (
                        <span className={`agent-avatar is-${agentKind}`} aria-hidden="true">
                          <AgentMark name={agentKind} size={16} />
                        </span>
                      ) : null}
                      <div className="who">
                        <span>
                          {agentKind === null
                            ? TYPE_LABEL[message.message_type]
                            : AGENT_LABEL[agentKind]}
                        </span>
                        <span>{formatTime(message.created_at)}</span>
                      </div>
                      <div className={isStructured ? 'tool-block' : 'bubble'}>{message.content}</div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {approvals.length > 0 ? (
            <div className="approval-stack">
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  busy={decidingId === approval.id}
                  onDecide={(decision, answers) => void handleDecision(approval, decision, answers)}
                />
              ))}
            </div>
          ) : null}

          <div className="composer-wrap">
            {!atBottom && active ? (
              <button
                type="button"
                className="jump-bottom"
                aria-label="回到最新消息"
                title="回到最新消息"
                onClick={() => void jumpToBottom()}
              >
                <ArrowDown size={16} strokeWidth={1.9} />
              </button>
            ) : null}
            {mentionOpen ? (
              <div className="mention-menu" role="menu">
                {(agentState?.bindings ?? []).length > 0 ? (
                  <>
                    <button type="button" className="mention-item" onClick={insertAllMentions}>
                      <span className="agent-avatar is-trinity" aria-hidden="true">
                        <AgentMark name="trinity" size={13} />
                      </span>
                      所有 Agent
                    </button>
                    <span className="mention-sep" aria-hidden="true" />
                  </>
                ) : null}
                {AGENT_ORDER.filter((kind) =>
                  (agentState?.bindings ?? []).some((binding) => binding.agent === kind),
                ).map((kind) => {
                  return (
                    <button
                      key={kind}
                      type="button"
                      className="mention-item"
                      onClick={() => insertMention(kind)}
                    >
                      <span className={`agent-avatar is-${kind}`} aria-hidden="true">
                        <AgentMark name={kind} size={14} />
                      </span>
                      {AGENT_LABEL[kind]}
                    </button>
                  );
                })}
                {(agentState?.bindings ?? []).length === 0 ? (
                  <span className="mention-empty">没有已绑定的 Agent</span>
                ) : null}
              </div>
            ) : null}

            <div className="composer">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder={connected ? '输入消息…' : '未连接 Trinity Core'}
                value={draft}
                disabled={!connected || !active}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (event.target.value.endsWith('@')) setMentionOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                    return;
                  }

                  if (event.key === 'Escape') setMentionOpen(false);
                }}
              />
              <button
                type="button"
                className="btn btn-ghost mention-toggle"
                onClick={() => setMentionOpen((value) => !value)}
                disabled={!active}
              >
                ＋ @提及 Agent
              </button>
              <button
                className="btn btn-primary"
                disabled={!connected || !active || sending || draft.trim() === ''}
                onClick={() => void handleSend()}
              >
                <Send size={15} strokeWidth={1.8} />
                {sending ? '发送中' : '发送'}
              </button>
            </div>
          </div>
          {active && conversationUsage ? (
            <div className="thread-usage" title={COST_NOTE}>
              <span className="thread-usage-item">
                本会话 <b>{formatTokens(conversationUsage.totals.total_tokens ?? null)}</b>
              </span>
              <span className="thread-usage-item">
                输入 <b>{formatTokens(conversationUsage.totals.input_tokens ?? null)}</b>
              </span>
              <span className="thread-usage-item">
                输出 <b>{formatTokens(conversationUsage.totals.output_tokens ?? null)}</b>
              </span>
              <span className="thread-usage-item">
                缓存读 <b>{formatTokens(conversationUsage.totals.cache_read_tokens ?? null)}</b>
              </span>
              <span className="thread-usage-item">
                成本 <b>{formatCost(conversationUsage.totals.cost_usd ?? null)}</b>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {menu !== null
        ? createPortal(
            <>
              <div className="context-menu-backdrop" onClick={() => setMenu(null)} />
              <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming({ id: menu.id, title: menu.title });
                    setRenameValue(menu.title);
                    setMenu(null);
                  }}
                >
                  重命名
                </button>
              </div>
            </>,
            document.body,
          )
        : null}

      {renaming !== null
        ? createPortal(
            <div className="dash-modal-backdrop" onClick={() => setRenaming(null)}>
              <div
                className="dash-modal"
                role="dialog"
                aria-label="重命名对话"
                style={{ width: 'min(420px, 100%)' }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="dash-modal-head">
                  <h2>重命名对话</h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setRenaming(null)}
                  >
                    关闭
                  </button>
                </div>
                <div className="dash-modal-body" style={{ whiteSpace: 'normal' }}>
                  <input
                    className="input"
                    aria-label="对话标题"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename();
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={renameBusy || renameValue.trim() === ''}
                      onClick={() => void handleRename()}
                    >
                      {renameBusy ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setRenaming(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
