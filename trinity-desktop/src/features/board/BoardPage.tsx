import { AlertTriangle, ClipboardList, Play, Plus, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { useCore } from '../../hooks/useCoreStatus';
import {
  closeBoardCard,
  createBoardCard,
  getBoardCard,
  getTeamSettings,
  listBoardCards,
  listConversations,
  startBoardCard,
  type AgentKind,
  type BoardCardDto,
  type BoardDetailDto,
  type ConversationDto,
} from '../../services/core-api';
import {
  CARD_STATUS_LABEL,
  CARD_STATUS_TONE,
  FINDING_LABEL,
  FINDING_TONE,
  PHASE_LABEL,
  formatTime,
  roundTone,
  truncate,
} from './format';

const LIST_POLL_MS = 5000;
const DETAIL_POLL_MS = 2500;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The todo panel hands a card id over through session storage. */
function takeFocusCard(): string | null {
  try {
    const id = sessionStorage.getItem('trinity.board.focus');

    if (id !== null) sessionStorage.removeItem('trinity.board.focus');

    return id;
  } catch {
    return null;
  }
}

function roundText(card: BoardCardDto): string {
  return `${card.cross_round_used} / ${card.cross_round_limit} 轮`;
}

export function BoardPage(): ReactElement {
  const { state } = useCore();
  const connected = state === 'connected';

  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [cards, setCards] = useState<BoardCardDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BoardDetailDto | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    title: '',
    goal: '',
    acceptance: '',
    constraints: '',
    requestedAgent: '',
  });

  useEffect(() => {
    if (!connected) {
      setConversations([]);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const [page, settings] = await Promise.all([
          listConversations({ limit: 100, sort: 'updated', order: 'desc' }),
          getTeamSettings(),
        ]);

        if (!alive) return;

        setConversations(page.items);
        setLimit(settings.cross_round_limit);
        setConversationId((current) => current ?? page.items[0]?.id ?? null);
      } catch (err) {
        if (alive) setError(messageOf(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, [connected]);

  const loadCards = useCallback(async (id: string): Promise<BoardCardDto[]> => {
    const page = await listBoardCards(id);
    setCards(page.items);

    return page.items;
  }, []);

  useEffect(() => {
    if (!connected || conversationId === null) {
      setCards([]);
      setSelectedId(null);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const items = await loadCards(conversationId);
        if (!alive) return;

        const focus = takeFocusCard();

        setSelectedId((current) => {
          if (focus !== null && items.some((card) => card.id === focus)) return focus;

          return current !== null && items.some((card) => card.id === current)
            ? current
            : (items[0]?.id ?? null);
        });
        setError(null);
      } catch (err) {
        if (alive) setError(messageOf(err));
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, LIST_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [connected, conversationId, loadCards]);

  useEffect(() => {
    if (selectedId === null || conversationId === null) {
      setDetail(null);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const next = await getBoardCard(conversationId, selectedId);
        if (alive) {
          setDetail(next);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(messageOf(err));
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, DETAIL_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedId, conversationId]);

  const handleCreate = async (): Promise<void> => {
    if (conversationId === null || busy) return;
    if (form.title.trim() === '' || form.goal.trim() === '') {
      setError('标题和目标都要写');
      return;
    }

    setBusy(true);

    try {
      const acceptance = form.acceptance
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

      const created = await createBoardCard(conversationId, {
        title: form.title.trim(),
        goal: form.goal.trim(),
        ...(acceptance.length === 0 ? {} : { acceptance }),
        ...(form.constraints.trim() === ''
          ? {}
          : { constraints_text: form.constraints.trim() }),
        ...(form.requestedAgent === ''
          ? {}
          : { requested_agent: form.requestedAgent as AgentKind }),
      });

      setForm({ title: '', goal: '', acceptance: '', constraints: '', requestedAgent: '' });
      setShowForm(false);
      await loadCards(conversationId);
      setSelectedId(created.card.id);
      setNotice('卡片已创建。点「开始交叉验证」让 Codex 派发。');
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (): Promise<void> => {
    if (conversationId === null || selectedId === null || busy) return;

    setBusy(true);

    try {
      await startBoardCard(conversationId, selectedId);
      setNotice('交叉验证已启动，在后台运行；进度会自动刷新。');
      setError(null);
      await loadCards(conversationId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async (): Promise<void> => {
    if (conversationId === null || selectedId === null || busy) return;

    setBusy(true);

    try {
      await closeBoardCard(conversationId, selectedId);
      setNotice('卡片已关闭。');
      setError(null);
      await loadCards(conversationId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = detail !== null && detail.card.id === selectedId ? detail : null;
  const selected = shown?.card ?? cards.find((card) => card.id === selectedId) ?? null;
  const canStart =
    selected !== null &&
    selected.status !== 'done' &&
    selected.status !== 'cancelled' &&
    selected.status !== 'failed' &&
    selected.claimed_by === null &&
    (selected.cross_phase === 'idle' || selected.cross_phase === 'waiting_user');

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>白板</h1>
          <p>任务卡、认领与交叉验证</p>
        </div>
        <div className="grow" />
        <button
          className="btn btn-primary"
          onClick={() => setShowForm((value) => !value)}
          disabled={!connected || conversationId === null}
        >
          <Plus size={15} strokeWidth={1.8} />
          新建卡
        </button>
      </div>

      <div className="page-body">
        {error !== null ? (
          <div className="card">
            <div className="card-body">
              <p className="secondary-text">操作失败：{error}</p>
            </div>
          </div>
        ) : null}

        {notice !== null ? (
          <div className="card">
            <div className="card-body">
              <p className="secondary-text">{notice}</p>
            </div>
          </div>
        ) : null}

        {!connected ? (
          <div className="card">
            <EmptyState
              icon={ClipboardList}
              title="未连接 Trinity Core"
              description="连上 Core 后，这里会显示真实的卡片。"
            />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="card-body" style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <label className="grow">
                  <span className="secondary-text">工作区</span>
                  <select
                    className="input"
                    value={conversationId ?? ''}
                    onChange={(event) => {
                      setConversationId(event.target.value || null);
                      setSelectedId(null);
                      setDetail(null);
                    }}
                  >
                    {conversations.map((conversation) => (
                      <option key={conversation.id} value={conversation.id}>
                        {conversation.title}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <span className="secondary-text">交叉验证上限</span>
                  <div className={`chip ${roundTone(limit ?? 5).replace('chip ', '')}`}>
                    {limit ?? '—'} 轮
                  </div>
                </div>
              </div>
            </div>

            {showForm ? (
              <div className="card">
                <div className="card-head">
                  <h2>新建任务卡</h2>
                </div>
                <div className="card-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                  <input
                    className="input"
                    placeholder="标题，例如：实现 add(a,b)"
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                  />
                  <textarea
                    className="input"
                    rows={3}
                    placeholder="目标：要达成什么"
                    value={form.goal}
                    onChange={(event) => setForm({ ...form, goal: event.target.value })}
                  />
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="验收标准，一行一条"
                    value={form.acceptance}
                    onChange={(event) => setForm({ ...form, acceptance: event.target.value })}
                  />
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="约束（可选）：不能做什么"
                    value={form.constraints}
                    onChange={(event) => setForm({ ...form, constraints: event.target.value })}
                  />
                  <label>
                    <span className="secondary-text">执行者（可选）</span>
                    <select
                      className="input"
                      aria-label="执行者"
                      value={form.requestedAgent}
                      onChange={(event) =>
                        setForm({ ...form, requestedAgent: event.target.value })
                      }
                    >
                      <option value="">默认：Codex 整理并分发</option>
                      <option value="claude">Claude 执行（跳过 Codex 派发）</option>
                      <option value="deepseek">DSH 执行（跳过 Codex 派发）</option>
                      <option value="codex">Codex 亲自执行</option>
                    </select>
                  </label>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={busy}>
                      {busy ? '创建中…' : '创建'}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setShowForm(false)}>
                      取消
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="cols">
              <div className="card">
                <div className="card-head">
                  <h2>卡片</h2>
                  <span className="chip">{cards.length}</span>
                </div>
                {cards.length === 0 ? (
                  <EmptyState
                    icon={ClipboardList}
                    title="还没有卡片"
                    description="点右上角「新建卡」，写下目标与验收标准。"
                  />
                ) : (
                  <div className="card-body">
                    {cards.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        className={`row${card.id === selectedId ? ' is-selected' : ''}`}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          background: card.id === selectedId ? 'var(--accent-soft)' : 'transparent',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          padding: 'var(--space-2)',
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelectedId(card.id)}
                      >
                        <span className="grow">
                          <span className="primary-text">{card.title}</span>
                          <br />
                          <span className="secondary-text">
                            {CARD_STATUS_LABEL[card.status]} · {roundText(card)}
                            {card.claimed_by ? ` · ${card.claimed_by}` : ''}
                          </span>
                        </span>
                        <span className={CARD_STATUS_TONE[card.status]}>
                          {card.cross_phase !== 'idle'
                            ? PHASE_LABEL[card.cross_phase]
                            : CARD_STATUS_LABEL[card.status]}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                {selected === null ? (
                  <EmptyState icon={ClipboardList} title="选一张卡" description="右侧显示卡片详情。" />
                ) : (
                  <>
                    <div className="card-head">
                      <h2>{selected.title}</h2>
                      <span className={CARD_STATUS_TONE[selected.status]}>
                        {CARD_STATUS_LABEL[selected.status]}
                      </span>
                    </div>
                    <div className="card-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                      <div>
                        <span className={`chip ${roundTone(selected.cross_round_limit).replace('chip ', '')}`}>
                          {roundText(selected)}
                        </span>{' '}
                        <span className="chip">{PHASE_LABEL[selected.cross_phase]}</span>{' '}
                        <span className="chip">创建者：{selected.created_by}</span>
                        {selected.requested_agent !== null ? (
                          <>
                            {' '}
                            <span className="chip chip-warning">
                              指定执行者：{selected.requested_agent}
                            </span>
                          </>
                        ) : null}
                      </div>

                      <div>
                        <div className="secondary-text">目标</div>
                        <p>{selected.goal}</p>
                      </div>

                      {selected.acceptance.length > 0 ? (
                        <div>
                          <div className="secondary-text">验收标准</div>
                          <ul>
                            {selected.acceptance.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {selected.constraints_text ? (
                        <div>
                          <div className="secondary-text">约束</div>
                          <p>{selected.constraints_text}</p>
                        </div>
                      ) : null}

                      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-primary"
                          onClick={() => void handleStart()}
                          disabled={!canStart || busy}
                        >
                          <Play size={15} strokeWidth={1.8} />
                          {busy ? '处理中…' : '开始交叉验证'}
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => void handleClose()}
                          disabled={busy || selected.status === 'done' || selected.status === 'cancelled'}
                        >
                          <XCircle size={15} strokeWidth={1.8} />
                          关闭卡
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => selectedId && conversationId && void getBoardCard(conversationId, selectedId).then(setDetail)}
                          disabled={busy}
                        >
                          <RefreshCw size={15} strokeWidth={1.8} />
                          刷新
                        </button>
                      </div>

                      {selected.cross_round_used >= selected.cross_round_limit ? (
                        <p className="secondary-text">
                          <AlertTriangle size={14} strokeWidth={1.8} /> 本轮轮数已用完；要再跑一组，直接点「开始交叉验证」，会从第 0 轮重新计数。
                        </p>
                      ) : null}

                      <div>
                        <div className="secondary-text">未决问题（{shown?.findings.filter((f) => f.status !== 'resolved' && f.status !== 'wontfix').length ?? 0}）</div>
                        {(shown?.findings ?? []).length === 0 ? (
                          <p className="secondary-text">暂无。</p>
                        ) : (
                          (shown?.findings ?? []).map((finding) => (
                            <div className="row" key={finding.id}>
                              <span className="grow">
                                <span className="primary-text">{finding.title}</span>
                                <br />
                                <span className="secondary-text">
                                  第 {finding.round_no} 轮 · {finding.raised_by}
                                  {finding.detail ? ` · ${truncate(finding.detail, 120)}` : ''}
                                </span>
                              </span>
                              <span className={FINDING_TONE[finding.status]}>
                                {FINDING_LABEL[finding.status]}
                              </span>
                            </div>
                          ))
                        )}
                      </div>

                      <div>
                        <div className="secondary-text">最近消息</div>
                        {(shown?.messages ?? []).slice(-6).map((message) => (
                          <div className="row" key={message.id}>
                            <span className="grow">
                              <span className="primary-text">
                                {message.from_agent ?? message.from_kind} · {message.kind}
                              </span>
                              <br />
                              <span className="secondary-text">{truncate(message.content, 200)}</span>
                            </span>
                            <span className="secondary-text">{formatTime(message.created_at)}</span>
                          </div>
                        ))}
                        {(shown?.messages ?? []).length === 0 ? (
                          <p className="secondary-text">暂无。</p>
                        ) : null}
                      </div>

                      <div>
                        <div className="secondary-text">事件</div>
                        {(shown?.events ?? []).slice(-8).map((event) => (
                          <div className="row" key={event.id}>
                            <span className="grow secondary-text">
                              {event.kind} · {event.actor}
                            </span>
                            <span className="secondary-text">{formatTime(event.created_at)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
