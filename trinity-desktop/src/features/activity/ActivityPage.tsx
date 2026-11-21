import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInspector } from '../../hooks/useInspector';
import {
  getActivityItem,
  getAgent,
  getUsageSummary,
  listActivity,
  listAllTasks,
  listConversations,
  type ActivityDetailDto,
  type ActivityItemDto,
  type AgentStateDto,
  type ConversationDto,
  type TaskDto,
  type UsageSummaryDto,
} from '../../services/core-api';
import { COST_NOTE, formatCost, formatTokens } from '../usage/format';

const POLL_MS = 2000;
const MAX_ACTIVITY = 300;
const INITIAL_ACTIVITY = 50;
const TICK_ACTIVITY = 100;

const KIND_LABEL: Record<string, string> = {
  tool_call: '工具调用',
  tool_result: '工具结果',
  task_status: '任务状态',
};

const AGENT_STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '执行中',
  error: '错误',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
};

const DELIVERY_LABEL: Record<string, string> = {
  pending: '送达未确认',
  delivered: '已送达',
  failed: '送达失败',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** Append by seq, never in place: a repeated or overlapping response must not duplicate a row. */
function mergeActivity(previous: ActivityItemDto[], incoming: ActivityItemDto[]): ActivityItemDto[] {
  if (incoming.length === 0) return previous;

  const seen = new Set(previous.map((item) => item.seq));
  const merged = [...previous];

  for (const item of incoming) {
    if (!seen.has(item.seq)) {
      seen.add(item.seq);
      merged.push(item);
    }
  }

  merged.sort((a, b) => a.seq - b.seq);

  return merged.length > MAX_ACTIVITY ? merged.slice(merged.length - MAX_ACTIVITY) : merged;
}

function toolNameOf(item: ActivityItemDto): string | null {
  const tool = item.metadata?.tool;
  return typeof tool === 'string' && tool !== '' ? tool : null;
}

function summaryOf(item: ActivityItemDto): string | null {
  const summary = item.metadata?.summary;
  return typeof summary === 'string' && summary !== '' ? summary : null;
}

export function ActivityPage({ onOpenUsage }: { onOpenUsage?: () => void }) {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentStateDto | null>(null);
  const [activity, setActivity] = useState<ActivityItemDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [moreHistory, setMoreHistory] = useState(false);
  const { selectedTask, toggleTask } = useInspector();
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openActivity, setOpenActivity] = useState<ActivityItemDto | null>(null);
  const [activityDetail, setActivityDetail] = useState<ActivityDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [usage, setUsage] = useState<UsageSummaryDto | null>(null);

  const generationRef = useRef(0);
  const cursorRef = useRef(0);
  const inFlightRef = useRef(false);

  const conversation = useMemo(
    () => conversations.find((item) => item.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  useEffect(() => {
    let cancelled = false;

    listConversations({ limit: 50, sort: 'updated', order: 'desc' })
      .then((page) => {
        if (cancelled) return;
        setConversations(page.items);
        setConversationId(page.items[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setStale(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (conversationId === null) return;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    cursorRef.current = 0;
    inFlightRef.current = false;

    setActivity([]);
    setMoreHistory(false);
    setOpenActivity(null);
    setActivityDetail(null);

    const loadInitial = async (): Promise<void> => {
      try {
        const [state, page, taskPage] = await Promise.all([
          getAgent(conversationId),
          listActivity(conversationId, { limit: INITIAL_ACTIVITY }),
          listAllTasks({ limit: 50 }),
        ]);

        if (generationRef.current !== generation) return;

        setAgent(state);
        setActivity(page.items);
        setMoreHistory(page.has_more);
        setTasks(taskPage.items);
        // The cursor stops at the newest row actually received. head_seq belongs
        // to the server's state and may sit past rows this page never saw.
        cursorRef.current = page.items.at(-1)?.seq ?? 0;
        setStale(false);
      } catch {
        if (generationRef.current === generation) setStale(true);
      }
    };

    const tick = async (): Promise<void> => {
      if (document.hidden || inFlightRef.current) return;

      inFlightRef.current = true;

      try {
        const [state, page, taskPage] = await Promise.all([
          getAgent(conversationId),
          listActivity(conversationId, { afterSeq: cursorRef.current, limit: TICK_ACTIVITY }),
          listAllTasks({ limit: 50 }),
        ]);

        if (generationRef.current !== generation) return;

        setAgent(state);
        setTasks(taskPage.items);

        if (page.items.length > 0) {
          setActivity((previous) => mergeActivity(previous, page.items));
          cursorRef.current = page.items[page.items.length - 1]!.seq;
        }

        setStale(false);
      } catch {
        if (generationRef.current === generation) setStale(true);
      } finally {
        inFlightRef.current = false;
      }
    };

    void loadInitial();

    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);

    const onVisibility = (): void => {
      if (!document.hidden) void tick();
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;

    getUsageSummary({})
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => {
        // The summary card is an extra; the dashboard still works without it.
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (openActivity === null) {
      setActivityDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    getActivityItem(openActivity.conversation_id, openActivity.message_id)
      .then((next) => {
        if (cancelled) return;
        setActivityDetail(next);
        setDetailLoading(false);
      })
      .catch(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [openActivity]);

  useEffect(() => {
    if (openActivity === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenActivity(null);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openActivity]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const first = activity[0];
    if (conversationId === null || first === undefined || historyLoading) return;

    const generation = generationRef.current;
    setHistoryLoading(true);

    try {
      const page = await listActivity(conversationId, { beforeSeq: first.seq, limit: INITIAL_ACTIVITY });
      if (generationRef.current !== generation) return;

      // History only extends what is already shown; the incremental cursor
      // keeps pointing at the newest row.
      setActivity((previous) => mergeActivity(previous, page.items));
      setMoreHistory(page.has_more);
    } catch {
      if (generationRef.current === generation) setStale(true);
    } finally {
      setHistoryLoading(false);
    }
  }, [activity, conversationId, historyLoading]);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Agent 活动与任务总览</p>
        </div>
        <div className="dash-toolbar">
          {stale ? <span className="dash-stale">连接异常，显示上次数据</span> : null}
          <select
            className="dash-select"
            value={conversationId ?? ''}
            onChange={(event) => setConversationId(event.target.value === '' ? null : event.target.value)}
            aria-label="选择会话"
          >
            {conversations.length === 0 ? <option value="">暂无会话</option> : null}
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="page-body dash">
        <div className="dash-main">
          <section className="dash-card">
            <header className="dash-card-head">
              <h2>Agent 状态</h2>
              <span className="dash-muted">{conversation?.title ?? '未选择会话'}</span>
            </header>
            <div className="dash-agents">
              {(agent?.bindings ?? []).map((binding) => (
                <div key={binding.agent} className={`dash-agent${binding.active ? ' is-active' : ''}`}>
                  <span className={`dash-dot is-${binding.status}`} />
                  <span className="dash-agent-name">{binding.display_name}</span>
                  <span className="dash-agent-state">
                    {AGENT_STATUS_LABEL[binding.status] ?? binding.status}
                  </span>
                </div>
              ))}
              {agent !== null && agent.bindings.length === 0 ? (
                <p className="dash-empty">这个会话还没有绑定 Agent</p>
              ) : null}
            </div>
          </section>

          <section className="dash-card dash-grow dash-timeline">
            <header className="dash-card-head">
              <h2>活动时间线</h2>
              {moreHistory && activity.length < MAX_ACTIVITY ? (
                <button type="button" className="dash-link" onClick={() => void loadOlder()} disabled={historyLoading}>
                  {historyLoading ? '加载中…' : '加载更早'}
                </button>
              ) : null}
            </header>
            <div className="dash-list">
              {activity.length === 0 ? (
                <p className="dash-empty">{loading ? '正在连接 Core…' : '暂无活动'}</p>
              ) : (
                activity.map((item) => (
                  <button
                    type="button"
                    className="dash-row"
                    key={item.seq}
                    onClick={() => setOpenActivity(item)}
                  >
                    <span className="dash-time">{formatTime(item.created_at)}</span>
                    <span className={`dash-kind is-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
                    <span className="dash-agent-tag">{item.agent ?? item.sender_id ?? '系统'}</span>
                    <span className="dash-text">
                      {toolNameOf(item) !== null ? <b className="dash-tool">{toolNameOf(item)}</b> : null}
                      {summaryOf(item) ?? (item.content_preview === toolNameOf(item) ? '' : item.content_preview)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>

        <aside className="dash-side">
          <section className="dash-card">
            <header className="dash-card-head">
              <h2>用量概览</h2>
              {onOpenUsage !== undefined ? (
                <button type="button" className="dash-link" onClick={onOpenUsage}>
                  查看用量
                </button>
              ) : null}
            </header>
            <div className="dash-usage">
              <div className="dash-usage-row">
                <span>总 Token</span>
                <b>{formatTokens(usage?.totals.total_tokens ?? null)}</b>
              </div>
              <div className="dash-usage-row">
                <span>输入 / 输出</span>
                <b>
                  {formatTokens(usage?.totals.input_tokens ?? null)} /{' '}
                  {formatTokens(usage?.totals.output_tokens ?? null)}
                </b>
              </div>
              <div className="dash-usage-row">
                <span>缓存读</span>
                <b>{formatTokens(usage?.totals.cache_read_tokens ?? null)}</b>
              </div>
              <div className="dash-usage-row" title={COST_NOTE}>
                <span>真实成本（估算）</span>
                <b>{formatCost(usage?.totals.cost_usd ?? null)}</b>
              </div>
            </div>
          </section>

          <section className="dash-card">
            <header className="dash-card-head">
              <h2>全局任务</h2>
              <span className="dash-muted">{tasks.length} 条</span>
            </header>
            <div className="dash-list">
              {tasks.length === 0 ? (
                <p className="dash-empty">暂无任务</p>
              ) : (
                tasks.map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    className={`dash-task${selectedTask?.id === task.id ? ' is-selected' : ''}`}
                    onClick={() => toggleTask(task)}
                  >
                    <span className="dash-task-title">{task.title}</span>
                    <span className="dash-task-meta">
                      {task.target_agent} · {TASK_STATUS_LABEL[task.status] ?? task.status} ·{' '}
                      {DELIVERY_LABEL[task.delivery_status] ?? task.delivery_status}
                    </span>
                    {task.conversation_title ? (
                      <span className="dash-task-conv">{task.conversation_title}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </section>

        </aside>
      </div>

      {openActivity !== null ? (
        <div
          className="dash-modal-backdrop"
          onClick={() => setOpenActivity(null)}
          role="presentation"
        >
          <div
            className="dash-modal"
            role="dialog"
            aria-modal="true"
            aria-label="活动详情"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dash-modal-head">
              <h2>{KIND_LABEL[openActivity.kind] ?? openActivity.kind}</h2>
              <button type="button" className="dash-link" onClick={() => setOpenActivity(null)} autoFocus>
                关闭
              </button>
            </header>

            <div className="kv"><span className="k">时间</span><span className="v">{formatTime(openActivity.created_at)}</span></div>
            <div className="kv">
              <span className="k">Agent</span>
              <span className="v">{openActivity.agent ?? openActivity.sender_id ?? '系统'}</span>
            </div>
            {toolNameOf(openActivity) !== null ? (
              <div className="kv"><span className="k">工具</span><span className="v">{toolNameOf(openActivity)}</span></div>
            ) : null}
            {typeof openActivity.metadata?.task_id === 'string' ? (
              <div className="kv"><span className="k">任务</span><span className="v">{openActivity.metadata.task_id}</span></div>
            ) : null}
            {summaryOf(openActivity) !== null ? (
              <div className="kv"><span className="k">摘要</span><span className="v">{summaryOf(openActivity)}</span></div>
            ) : null}

            <h3 className="dash-sub">
              {openActivity.kind === 'tool_call' || openActivity.kind === 'tool_result'
                ? 'Agent 原始输出'
                : '内容'}
            </h3>
            {openActivity.kind === 'tool_call' || openActivity.kind === 'tool_result' ? (
              <p className="dash-muted">未脱敏，可能包含敏感信息</p>
            ) : null}

            <div className="dash-modal-body">
              {activityDetail?.content ?? openActivity.content_preview}
              {detailLoading ? <span className="dash-muted">（正在加载完整内容…）</span> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
