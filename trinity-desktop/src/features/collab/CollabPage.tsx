import {
  AlertTriangle,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  cancelCollabRound,
  createCollabRound,
  getAgent,
  getCollabRound,
  listCollabRounds,
  listConversations,
  resumeCollabRound,
  type AgentSessionDto,
  type CollabDetailDto,
  type CollabRoundDto,
  type ConversationDto,
} from '../../services/core-api';
import {
  agentLabel,
  budgetPercent,
  budgetTone,
  chipClass,
  formatTime,
  isTerminal,
  MESSAGE_KIND,
  OUTCOME_LABEL,
  outcomeTone,
  REVIEW_STATUS,
  reviewTone,
  ROLE_LABEL,
  ROUND_STATUS,
  roundTone,
  TASK_STATUS,
  taskTone,
  truncate,
  usageLabel,
} from './format';

const LIST_POLL_MS = 4000;
const DETAIL_POLL_MS = 2000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CollabPage(): ReactElement {
  const [rounds, setRounds] = useState<CollabRoundDto[]>([]);
  const [selected, setSelected] = useState<{ id: string; conversationId: string } | null>(null);
  const [detail, setDetail] = useState<CollabDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [acting, setActing] = useState(false);

  const select = useCallback((round: CollabRoundDto) => {
    setSelected({ id: round.id, conversationId: round.conversation_id });
    setDetail(null);
  }, []);

  const loadRounds = useCallback(async (): Promise<void> => {
    try {
      const page = await listCollabRounds({ limit: 100 });
      setRounds(page.items);
      setError(null);

      setSelected((current) => {
        if (current !== null) return current;

        const first = page.items[0];
        return first === undefined
          ? null
          : { id: first.id, conversationId: first.conversation_id };
      });
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void loadRounds();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadRounds();
    }, LIST_POLL_MS);

    return () => window.clearInterval(timer);
  }, [loadRounds]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }

    let stopped = false;
    let timer = 0;

    const load = async (): Promise<void> => {
      try {
        const next = await getCollabRound(selected.conversationId, selected.id);

        if (stopped) return;

        setDetail(next);

        if (isTerminal(next.round.status)) {
          window.clearInterval(timer);
          void loadRounds();
        }
      } catch (err) {
        if (!stopped) setError(messageOf(err));
      }
    };

    void load();
    timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, DETAIL_POLL_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selected, loadRounds]);

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    if (acting) return;

    setActing(true);

    try {
      await work();
      setError(null);
      await loadRounds();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setActing(false);
    }
  };

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>自主协作</h1>
          <p>一个目标进入，一支 Agent 团队工作，一个经过审查的结果交付。</p>
        </div>
        <div className="grow" />
        <button type="button" className="btn" onClick={() => void loadRounds()}>
          <RefreshCw size={14} strokeWidth={1.8} />
          刷新
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={15} strokeWidth={2} />
          发起协作
        </button>
      </div>

      {error !== null ? (
        <div className="banner collab-banner-error">
          <AlertTriangle size={15} strokeWidth={1.8} />
          {error}
        </div>
      ) : null}

      <div className="page-body">
        <div className="collab-layout">
          <aside className="collab-list" aria-label="协作轮次">
            {rounds.length === 0 ? (
              <div className="empty">
                <span className="empty-glyph">
                  <Network size={20} strokeWidth={1.6} />
                </span>
                <h3>还没有协作轮次</h3>
                <p>点「发起协作」，Core 会创建轮次、确定协调者，并让 Agent 真正开始工作。</p>
              </div>
            ) : (
              rounds.map((round) => (
                <button
                  key={round.id}
                  type="button"
                  className={`collab-item${round.id === selected?.id ? ' is-selected' : ''}`}
                  onClick={() => select(round)}
                  aria-current={round.id === selected?.id ? 'true' : undefined}
                >
                  <div className="collab-item-goal">{truncate(round.goal, 46)}</div>
                  <div className="collab-item-meta">
                    <span className={chipClass(roundTone(round.status))}>
                      {ROUND_STATUS[round.status]}
                    </span>
                    {round.outcome !== null ? (
                      <span className={chipClass(outcomeTone(round.outcome))}>
                        {OUTCOME_LABEL[round.outcome]}
                      </span>
                    ) : null}
                  </div>
                  <div className="collab-item-meta">
                    {round.conversation_title ?? round.conversation_id.slice(0, 8)} ·{' '}
                    {formatTime(round.created_at)}
                  </div>
                </button>
              ))
            )}
          </aside>

          <div className="collab-detail">
            {detail === null ? (
              <div className="empty">
                <span className="empty-glyph">
                  <Network size={20} strokeWidth={1.6} />
                </span>
                <h3>{selected === null ? '选择一个轮次' : '正在读取轮次…'}</h3>
                <p>轮次的目标、角色、任务、内部消息、审查与最终交付都会显示在这里。</p>
              </div>
            ) : (
              <RoundView
                detail={detail}
                acting={acting}
                onCancel={() =>
                  void act(() =>
                    cancelCollabRound(detail.round.conversation_id, detail.round.id),
                  )
                }
                onResume={(options) =>
                  void act(() =>
                    resumeCollabRound(detail.round.conversation_id, detail.round.id, options),
                  )
                }
              />
            )}
          </div>
        </div>
      </div>

      {createOpen ? (
        <CreateRoundDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(round) => {
            setCreateOpen(false);
            select(round);
            void loadRounds();
          }}
        />
      ) : null}
    </section>
  );
}

interface RoundViewProps {
  detail: CollabDetailDto;
  acting: boolean;
  onCancel: () => void;
  onResume: (options: {
    budgetUsageTokens?: number;
    budgetHops?: number;
    minAssignments?: number;
    retryPlanning?: boolean;
  }) => void;
}

function RoundView({ detail, acting, onCancel, onResume }: RoundViewProps): ReactElement {
  const { round } = detail;
  const [resumeTokens, setResumeTokens] = useState('');
  const [resumeHops, setResumeHops] = useState('');
  const running = !isTerminal(round.status);
  const waiting = round.status === 'blocked';

  return (
    <>
      <div className="card collab-hero">
        <h2>{round.goal}</h2>
        <div className="collab-chips">
          <span className={chipClass(roundTone(round.status))}>{ROUND_STATUS[round.status]}</span>
          {round.outcome !== null ? (
            <span className={chipClass(outcomeTone(round.outcome))}>
              {OUTCOME_LABEL[round.outcome]}
            </span>
          ) : null}
          {round.review_required ? (
            <span className="chip">
              <ShieldCheck size={12} strokeWidth={2} />
              需要独立审查
            </span>
          ) : null}
          <span className="chip">协调者：{agentLabel(round.coordinator)}</span>
          {round.min_assignments > 0 ? (
            <span className="chip chip-accent">
              要求至少 {round.min_assignments} 个 Agent 分工
            </span>
          ) : null}
          <span className="chip">创建于 {formatTime(round.created_at)}</span>
          {round.closed_at !== null ? (
            <span className="chip">结束于 {formatTime(round.closed_at)}</span>
          ) : null}
        </div>

        <div className="collab-budget">
          <BudgetBar
            label="传播 hop"
            used={round.budgets.hops.used}
            limit={round.budgets.hops.limit}
            text={`${round.budgets.hops.used} / ${round.budgets.hops.limit} 跳`}
          />
          <BudgetBar
            label="执行回合"
            used={round.budgets.exec.used}
            limit={round.budgets.exec.limit}
            text={`${round.budgets.exec.used} / ${round.budgets.exec.limit} 回合`}
          />
          <div className="collab-budget-row">
            <span>用量</span>
            <span />
            <span>{usageLabel(detail.usage.tokens, round.budgets.usage_tokens.limit)}</span>
          </div>
        </div>

        <div className="collab-actions">
          {running ? (
            <button type="button" className="btn" onClick={onCancel} disabled={acting}>
              <XCircle size={14} strokeWidth={1.8} />
              取消本轮
            </button>
          ) : null}
        </div>
      </div>

      {waiting ? (
        <div className="card collab-hero collab-blocked">
          <h3>本轮在等待</h3>
          <p>{round.blocked_reason ?? '等待条件满足后继续'}</p>
          <p className="dash-muted">
            唤醒条件：
            {round.wake_condition === 'user_approval'
              ? '用户授权'
              : round.wake_condition === 'user_decision'
                ? '用户决定'
                : round.wake_condition === 'propagation_limit'
                  ? '用户提高传播预算'
                  : round.wake_condition}
          </p>
          {round.wake_condition === 'propagation_limit' ? (
            <div className="collab-row">
              <label className="collab-field">
                新的传播上限（hop）
                <input
                  type="number"
                  min={1}
                  value={resumeHops}
                  onChange={(event) => setResumeHops(event.target.value)}
                  placeholder={`当前 ${round.budgets.hops.limit}`}
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting || Number(resumeHops) <= 0}
                onClick={() => onResume({ budgetHops: Math.trunc(Number(resumeHops)) })}
              >
                提高传播上限并继续
              </button>
            </div>
          ) : null}
          {round.wake_condition === 'user_approval' ? (
            <div className="collab-row">
              <label className="collab-field">
                新的用量上限（tokens）
                <input
                  type="number"
                  min={1}
                  value={resumeTokens}
                  onChange={(event) => setResumeTokens(event.target.value)}
                  placeholder="例如 200000"
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting || Number(resumeTokens) <= 0}
                onClick={() => onResume({ budgetUsageTokens: Math.trunc(Number(resumeTokens)) })}
              >
                提高上限并恢复
              </button>
            </div>
          ) : null}
          {round.wake_condition === 'user_decision' ? (
            <div className="collab-row">
              <p className="dash-muted">
                协调者没有满足你提出的分工要求。可以放宽要求让它继续，或取消本轮重新发起。
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting}
                onClick={() => onResume({ minAssignments: 0 })}
              >
                放宽分工要求并继续
              </button>
              <button
                type="button"
                className="btn"
                disabled={acting}
                onClick={() => onResume({ retryPlanning: true })}
              >
                要求重新规划
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>角色</h2>
        </div>
        <div className="card-body collab-role-list">
          {detail.roles.map((role) => (
            <div key={`${role.round_id}-${role.agent}`} className="collab-role">
              <span className="collab-role-agent">{agentLabel(role.agent)}</span>
              <span className={chipClass(role.role === 'coordinator' ? 'accent' : 'default')}>
                {ROLE_LABEL[role.role] ?? role.role}
              </span>
              {role.reason !== null ? (
                <span className="dash-muted">{truncate(role.reason, 60)}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>分工与任务进度</h2>
          <span className="dash-muted">{detail.tasks.length} 个任务</span>
        </div>
        <div className="card-body collab-tasks">
          {detail.tasks.length === 0 ? (
            <p className="dash-muted collab-pad">还没有任务。</p>
          ) : (
            detail.tasks.map((task) => (
              <div key={task.id} className="collab-task">
                <span className={chipClass(taskTone(task.status))}>
                  {TASK_STATUS[task.status] ?? task.status}
                </span>
                <div className="collab-task-body">
                  <div className="collab-task-title">{task.title}</div>
                  <div className="collab-task-meta">
                    {agentLabel(task.target_agent)} · {task.task_type}
                    {task.source_agent !== null ? ` · 来自 ${agentLabel(task.source_agent)}` : ''}
                    {task.finished_at !== null ? ` · ${formatTime(task.finished_at)}` : ''}
                  </div>
                  {task.error_text !== null ? (
                    <div className="collab-task-error">{task.error_text}</div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {detail.contributions.length > 0 ? (
        <div className="card">
          <div className="card-head">
            <h2>Agent 自主输出</h2>
            <span className="dash-muted">不计入任务，但属于本轮成果</span>
          </div>
          <div className="card-body">
            {detail.contributions.map((contribution) => (
              <div key={contribution.id} className="collab-contribution">
                <div className="collab-task-meta">
                  {agentLabel(contribution.agent)} · {contribution.phase} ·{' '}
                  {formatTime(contribution.created_at)}
                </div>
                <div className="collab-message-body">
                  {truncate(contribution.content, 1200)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>审查</h2>
        </div>
        <div className="card-body collab-reviews">
          {detail.reviews.length === 0 ? (
            <p className="dash-muted collab-pad">
              {detail.round.review_required ? '尚未审查。' : '本轮未要求独立审查。'}
            </p>
          ) : (
            detail.reviews.map((review) => (
              <div key={review.id} className="collab-review">
                <div className="collab-review-head">
                  <span className={chipClass(reviewTone(review.status))}>
                    {REVIEW_STATUS[review.status]}
                  </span>
                  <span className="dash-muted">
                    审查者：{review.reviewer === null ? '无（不可用）' : agentLabel(review.reviewer)}
                    {review.same_provider === false ? ' · 不同 Provider' : ''}
                    {review.same_provider === true ? ' · 同一 Provider' : ''}
                  </span>
                  <span className="dash-muted">{formatTime(review.created_at)}</span>
                </div>
                {review.findings.length > 0 ? (
                  <ul className="collab-findings">
                    {review.findings.map((finding, index) => (
                      <li key={`${review.id}-${index}`}>{finding}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>最终交付</h2>
        </div>
        <div className="card-body">
          {detail.delivery === null ? (
            <p className="dash-muted collab-pad">还没有交付结论。</p>
          ) : (
            <pre className="collab-delivery">{detail.delivery.content}</pre>
          )}
        </div>
      </div>

      <details className="card collab-messages">
        <summary className="collab-messages-head">
          内部消息（{detail.messages.length}）
        </summary>
        <div className="card-body">
          {detail.messages.length === 0 ? (
            <p className="dash-muted collab-pad">还没有内部消息。</p>
          ) : (
            detail.messages.map((message) => (
              <div key={message.id} className="collab-message">
                <div className="collab-message-head">
                  {formatTime(message.created_at)} · {agentLabel(message.from_agent)} →{' '}
                  {agentLabel(message.to_agent)} · {MESSAGE_KIND[message.kind] ?? message.kind} ·{' '}
                  {message.state} · hop {message.hop}
                </div>
                <div className="collab-message-body">{truncate(message.content, 500)}</div>
                {message.reason !== null ? (
                  <div className="dash-muted">理由：{message.reason}</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </details>
    </>
  );
}

function BudgetBar({
  label,
  used,
  limit,
  text,
}: {
  label: string;
  used: number;
  limit: number;
  text: string;
}): ReactElement {
  const tone = budgetTone(used, limit);
  const width = Math.max(budgetPercent(used, limit), used > 0 ? 4 : 0);

  return (
    <div className="collab-budget-row">
      <span>{label}</span>
      <span className={`collab-bar${tone === 'default' ? '' : ` is-${tone}`}`}>
        <span style={{ width: `${width}%` }} />
      </span>
      <span>{text}</span>
    </div>
  );
}

interface CreateRoundDialogProps {
  onClose: () => void;
  onCreated: (round: CollabRoundDto) => void;
}

function CreateRoundDialog({ onClose, onCreated }: CreateRoundDialogProps): ReactElement {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [bindings, setBindings] = useState<AgentSessionDto[]>([]);
  const [goal, setGoal] = useState('');
  const [coordinator, setCoordinator] = useState('');
  const [review, setReview] = useState(true);
  const [minAssignments, setMinAssignments] = useState('0');
  const [execBudget, setExecBudget] = useState('12');
  const [usageBudget, setUsageBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;

    void (async () => {
      try {
        const page = await listConversations({ limit: 50 });

        if (stopped) return;

        setConversations(page.items);

        if (page.items[0]) setConversationId(page.items[0].id);
      } catch (err) {
        if (!stopped) setError(messageOf(err));
      }
    })();

    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (conversationId === '') {
      setBindings([]);
      setCoordinator('');
      return;
    }

    let stopped = false;

    void (async () => {
      try {
        const state = await getAgent(conversationId);

        if (stopped) return;

        setBindings(state.bindings);
        setCoordinator(state.active_agent ?? state.bindings[0]?.agent ?? '');
      } catch {
        if (!stopped) setBindings([]);
      }
    })();

    return () => {
      stopped = true;
    };
  }, [conversationId]);

  const submit = async (): Promise<void> => {
    if (busy) return;

    const text = goal.trim();

    if (text === '') {
      setError('请写下这一轮要达成的目标');
      return;
    }

    const exec = Number(execBudget);

    if (!Number.isInteger(exec) || exec < 1) {
      setError('执行预算必须是正整数');
      return;
    }

    const usage = usageBudget.trim() === '' ? undefined : Number(usageBudget);

    if (usage !== undefined && (!Number.isInteger(usage) || usage < 1)) {
      setError('用量上限必须是正整数或留空');
      return;
    }

    setBusy(true);

    try {
      const created = await createCollabRound(conversationId, {
        goal: text,
        ...(coordinator === '' ? {} : { coordinator }),
        review_required: review,
        ...(Number(minAssignments) > 0 ? { min_assignments: Number(minAssignments) } : {}),
        budget_exec: exec,
        ...(usage === undefined ? {} : { budget_usage_tokens: usage }),
      });

      onCreated(created.round);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="dash-modal"
        role="dialog"
        aria-modal="true"
        aria-label="发起协作"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dash-modal-head">
          <h2>发起协作</h2>
          <button type="button" className="dash-link" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="collab-form">
          <label className="collab-field">
            对话
            <select
              value={conversationId}
              onChange={(event) => setConversationId(event.target.value)}
            >
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
          </label>

          {conversations.length > 0 && bindings.length === 0 ? (
            <p className="dash-muted">这个对话还没有绑定 Agent，先到「对话」页绑定。</p>
          ) : null}

          <label className="collab-field">
            目标
            <textarea
              rows={4}
              value={goal}
              maxLength={8000}
              placeholder="例如：做一份关于 Trinity 自主协作的 PPT，包含架构图与演示流程"
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>

          <div className="collab-row">
            <label className="collab-field">
              协调者
              <select
                value={coordinator}
                onChange={(event) => setCoordinator(event.target.value)}
              >
                <option value="">自动选择</option>
                {bindings.map((binding) => (
                  <option key={binding.agent} value={binding.agent}>
                    {agentLabel(binding.agent)}
                  </option>
                ))}
              </select>
            </label>
            <label className="collab-field">
              执行预算（回合）
              <input
                type="number"
                min={1}
                max={200}
                value={execBudget}
                onChange={(event) => setExecBudget(event.target.value)}
              />
            </label>
            <label className="collab-field">
              用量上限（tokens，可留空）
              <input
                type="number"
                min={1}
                value={usageBudget}
                placeholder="不限"
                onChange={(event) => setUsageBudget(event.target.value)}
              />
            </label>
          </div>

          <label className="collab-field">
            分工要求
            <select
              value={minAssignments}
              onChange={(event) => setMinAssignments(event.target.value)}
            >
              <option value="0">自动（由协调者决定）</option>
              <option value="2">必须由至少 2 个 Agent 分工</option>
              <option value="3">必须由至少 3 个 Agent 分工</option>
            </select>
          </label>

          <label className="collab-check">
            <input
              type="checkbox"
              checked={review}
              onChange={(event) => setReview(event.target.checked)}
            />
            正式交付前做独立审查
          </label>

          {error !== null ? <p className="collab-form-error">{error}</p> : null}

          <div className="collab-form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={busy || conversationId === '' || bindings.length === 0}
            >
              {busy ? '正在创建…' : '开始协作'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
