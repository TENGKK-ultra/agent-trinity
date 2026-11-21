import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useCore } from '../hooks/useCoreStatus';
import {
  INSPECTOR_PANEL_LABEL,
  INSPECTOR_PANELS,
  useInspector,
} from '../hooks/useInspector';
import {
  getTaskDetail,
  getTaskUsage,
  listAgentDirectory,
  listOpenBoardFindings,
  type AgentDirectoryDto,
  type BoardFindingDto,
  type TaskDetailDto,
  type UsageTaskDto,
} from '../services/core-api';
import { coreTarget } from '../services/core-config';
import { FINDING_LABEL, FINDING_TONE } from '../features/board/format';
import { COST_NOTE, formatCost, formatTokens } from '../features/usage/format';
import { ConversationControlBar } from './ConversationControlBar';
import { useConversationControls } from '../hooks/useConversationControls';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/messages';

const PERMISSION_OPTIONS = [
  ['manual', 'insp.perm.manual', 'insp.perm.manual.desc'],
  ['acceptEdits', 'insp.perm.acceptEdits', 'insp.perm.acceptEdits.desc'],
  ['plan', 'insp.perm.plan', 'insp.perm.plan.desc'],
  ['bypassPermissions', 'insp.perm.bypass', 'insp.perm.bypass.desc'],
] as const satisfies ReadonlyArray<readonly [string, MessageKey, MessageKey]>;

const POLL_MS = 2000;

const TASK_STATUS_LABEL: Record<string, MessageKey> = {
  queued: 'insp.task.queued',
  running: 'insp.task.running',
  completed: 'insp.task.completed',
  failed: 'insp.task.failed',
  timeout: 'insp.task.timeout',
  cancelled: 'insp.task.cancelled',
};

const DELIVERY_LABEL: Record<string, MessageKey> = {
  pending: 'insp.delivery.pending',
  delivered: 'insp.delivery.delivered',
  failed: 'insp.delivery.failed',
};

const STEP_MS = 240;

/**
 * A drawn chevron rather than an icon-font glyph: round caps, a slight bow and
 * a heavier stroke, so it reads as a soft Apple-style arrow instead of a thin
 * angle bracket. The left one is mirrored inside the path, leaving the element
 * free for the translate that positions it.
 */
function Chevron({ direction, className }: { direction: 'prev' | 'next'; className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 10 12"
      width={8}
      height={10}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.4 1.8C5 4.2 6.8 5.4 6.8 6C6.8 6.6 5 7.8 2.4 10.2"
        transform={direction === 'prev' ? 'translate(10 0) scale(-1 1)' : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Two chevrons that advance one place and let a faint third take the rear.
 * Landing on the last page never produces that new chevron; the button simply
 * settles back to a single one.
 */
function PageStepButton({
  direction,
  disabled,
  busy,
  step,
  stepDir,
  terminal,
  onClick,
}: {
  direction: 'prev' | 'next';
  disabled: boolean;
  /** Shared with the sibling: the other side reacts to the same click. */
  busy: boolean;
  step: number;
  stepDir: 'prev' | 'next' | null;
  terminal: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const [settled, setSettled] = useState(false);
  const stepping = step > 0 && stepDir === direction;
  const nudged = step > 0 && stepDir !== null && stepDir !== direction;

  // A terminal step leaves one chevron behind. Without this the trailing one
  // snaps back to its resting spot for a frame before the button disables.
  useEffect(() => {
    setSettled(false);
  }, [step]);

  // Jumping away with a dot does not step, so the settled state must also clear
  // as soon as there is somewhere to go again.
  useEffect(() => {
    if (!disabled) setSettled(false);
  }, [disabled]);

  const className = [
    'insp-page-btn',
    `is-${direction}`,
    stepping ? 'is-stepping' : '',
    nudged ? `is-nudged-${stepDir === 'next' ? 'left' : 'right'}` : '',
    stepping && terminal ? 'is-terminal' : '',
    settled ? 'is-settled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      disabled={disabled && !busy}
      aria-label={direction === 'next' ? t('insp.nextPage') : t('insp.prevPage')}
      onClick={onClick}
    >
      <span
        key={step}
        className="insp-chev-group"
        onAnimationEnd={() => {
          if (stepping && terminal) setSettled(true);
        }}
      >
        <Chevron direction={direction} className="insp-chev is-lead" />
        <Chevron direction={direction} className="insp-chev is-trail" />
        <Chevron direction={direction} className="insp-chev is-new" />
      </span>
    </button>
  );
}

export function Inspector() {
  const t = useT();
  const { state, lastCheckedAt, lastError } = useCore();
  const { panel, selectedTask, setPanel, closeTask } = useInspector();
  const {
    permissionMode,
    choosePermissionMode,
    busy: controlsBusy,
  } = useConversationControls();
  const [detail, setDetail] = useState<TaskDetailDto | null>(null);
  const [taskUsage, setTaskUsage] = useState<UsageTaskDto | null>(null);
  const [step, setStep] = useState(0);
  const [stepDir, setStepDir] = useState<'prev' | 'next' | null>(null);
  const [stepTerminal, setStepTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const busyTimer = useRef<number | null>(null);
  const [directory, setDirectory] = useState<AgentDirectoryDto[] | null>(null);
  const [todoFindings, setTodoFindings] = useState<BoardFindingDto[]>([]);

  useEffect(
    () => () => {
      if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (state !== 'connected') {
      setDirectory(null);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const page = await listAgentDirectory();
        if (alive) setDirectory(page.items);
      } catch {
        if (alive) setDirectory(null);
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'connected') {
      setTodoFindings([]);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const page = await listOpenBoardFindings(50);
        if (alive) setTodoFindings(page.items);
      } catch {
        if (alive) setTodoFindings([]);
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [state]);

  const stateLabel =
    state === 'connected'
      ? t('insp.connected')
      : state === 'connecting'
        ? t('insp.connecting')
        : t('insp.offline');
  const target = coreTarget();
  const checkedLabel = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';

  useEffect(() => {
    if (selectedTask === null) {
      setDetail(null);
      return;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      // The drawer keeps its state, but polling pauses while it is not the
      // page on screen or the window is hidden.
      if (document.hidden || panel !== 'info') return;

      try {
        const next = await getTaskDetail(selectedTask.conversation_id, selectedTask.id);
        if (!cancelled) setDetail(next);
      } catch {
        // Keep the last successful detail rather than blanking the panel.
      }
    };

    void load();

    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedTask, panel]);

  useEffect(() => {
    if (selectedTask === null) {
      setTaskUsage(null);
      return;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      if (document.hidden) return;

      try {
        const next = await getTaskUsage(selectedTask.conversation_id, selectedTask.id);
        if (!cancelled) setTaskUsage(next);
      } catch {
        // Usage is supplementary; keep the last value rather than blanking it.
      }
    };

    void load();

    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedTask]);

  const detailTask = detail?.task ?? selectedTask;
  const index = INSPECTOR_PANELS.indexOf(panel);

  // One click moves both sides: the pressed button advances its chevrons, the
  // other nudges the same way, then everything settles.
  const stepTo = (direction: 'prev' | 'next'): void => {
    const target = direction === 'next' ? index + 1 : index - 1;
    if (target < 0 || target >= INSPECTOR_PANELS.length) return;

    setStepDir(direction);
    setStepTerminal(
      direction === 'next' ? target === INSPECTOR_PANELS.length - 1 : target === 0,
    );
    setStep((value) => value + 1);
    setBusy(true);

    if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => setBusy(false), STEP_MS);

    setPanel(INSPECTOR_PANELS[target]!);
  };

  return (
    <aside className="inspector" aria-label={t('insp.aria')}>
      <div className="insp-dots">
        <PageStepButton
          direction="prev"
          disabled={index === 0}
          busy={busy}
          step={step}
          stepDir={stepDir}
          terminal={stepTerminal}
          onClick={() => stepTo('prev')}
        />

        <div className="insp-dot-row" role="tablist" aria-label={t('insp.tab.info')}>
          {INSPECTOR_PANELS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`insp-dot${id === panel ? ' is-active' : ''}`}
              aria-selected={id === panel}
              aria-label={INSPECTOR_PANEL_LABEL[id]}
              title={INSPECTOR_PANEL_LABEL[id]}
              onClick={() => setPanel(id)}
            />
          ))}
        </div>

        <PageStepButton
          direction="next"
          disabled={index === INSPECTOR_PANELS.length - 1}
          busy={busy}
          step={step}
          stepDir={stepDir}
          terminal={stepTerminal}
          onClick={() => stepTo('next')}
        />
      </div>

      <div className="insp-viewport">
        <div className="insp-track" style={{ transform: `translateX(-${index * 100}%)` }}>
          <section
            className="insp-panel"
            role="tabpanel"
            aria-label={t('insp.tab.info')}
            inert={panel !== 'info'}
          >
            <div className="insp-title">{t('insp.tab.info')}</div>

            <h3 className="dash-sub">{t('insp.backend')}</h3>
            <div className="insp-card">
              <div className="insp-line">
                <span className="k">{t('insp.addr')}</span>
                <span className="v mono">{target.display}</span>
              </div>
              <div className="insp-line">
                <span className="k">{t('insp.state')}</span>
                <span className="v">{stateLabel}</span>
              </div>
              <div className="insp-line">
                <span className="k">{t('insp.lastCheck')}</span>
                <span className="v">{checkedLabel}</span>
              </div>
            </div>
            {lastError ? <div className="insp-note">{lastError}</div> : null}

            <h3 className="dash-sub">Agent</h3>
            <div className="insp-card">
              {directory === null ? (
                <div className="insp-line">
                  <span className="k">{t('insp.dir')}</span>
                  <span className="v">{state === 'connected' ? t('insp.reading') : t('insp.offline')}</span>
                </div>
              ) : (
                directory.map((entry) => (
                  <div className="insp-line" key={entry.agent}>
                    <span className="k">{entry.display_name}</span>
                    <span className="v">
                      {entry.running_conversations > 0
                        ? t('insp.agent.running').replace('{n}', String(entry.running_conversations))
                        : entry.bound_conversations > 0
                          ? t('insp.agent.bound').replace('{n}', String(entry.bound_conversations))
                          : t('insp.agent.unbound')}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="insp-note">
              {t('insp.agents.note')}
            </div>

            {detailTask === null ? null : (
              <>
                <h3 className="dash-sub insp-title-row">
                  <span>{t('insp.taskDetail')}</span>
                  <button type="button" className="dash-link" onClick={closeTask}>
                    关闭
                  </button>
                </h3>

                <div className="insp-card">
                  <div className="insp-line">
                    <span className="k">{t('insp.source')}</span>
                    <span className="v">{detailTask.source_agent ?? t('insp.unknown')}</span>
                  </div>
                  <div className="insp-line">
                    <span className="k">{t('insp.goal')}</span>
                    <span className="v">{detailTask.target_agent}</span>
                  </div>
                  <div className="insp-line">
                    <span className="k">{t('insp.runState')}</span>
                    <span className="v">
                      {TASK_STATUS_LABEL[detailTask.status] !== undefined
                        ? t(TASK_STATUS_LABEL[detailTask.status]!)
                        : detailTask.status}
                    </span>
                  </div>
                  <div className="insp-line">
                    <span className="k">{t('insp.delivery')}</span>
                    <span className="v">
                      {DELIVERY_LABEL[detailTask.delivery_status] !== undefined
                        ? t(DELIVERY_LABEL[detailTask.delivery_status]!)
                        : detailTask.delivery_status}
                    </span>
                  </div>
                  {detailTask.error_text ? (
                    <div className="insp-line">
                      <span className="k">{t('insp.error')}</span>
                      <span className="v">{detailTask.error_text}</span>
                    </div>
                  ) : null}
                </div>

                <h3 className="dash-sub">{t('insp.promptPreview')}</h3>
                <p className="dash-pre">{detailTask.instruction_preview}</p>

                <h3 className="dash-sub">{t('insp.resultPreview')}</h3>
                <p className="dash-pre">{detail?.result?.content_preview ?? t('insp.noResult')}</p>

                <h3 className="dash-sub">{t('insp.usage')}</h3>
                <div className="insp-card">
                  <div className="insp-line">
                    <span className="k">{t('insp.io')}</span>
                    <span className="v">
                      {formatTokens(taskUsage?.totals.input_tokens ?? null)} /{' '}
                      {formatTokens(taskUsage?.totals.output_tokens ?? null)}
                    </span>
                  </div>
                  <div className="insp-line">
                    <span className="k">{t('insp.cache')}</span>
                    <span className="v">
                      {formatTokens(taskUsage?.totals.cache_read_tokens ?? null)} /{' '}
                      {formatTokens(taskUsage?.totals.cache_write_tokens ?? null)}
                    </span>
                  </div>
                  <div className="insp-line">
                    <span className="k">{t('insp.total')}</span>
                    <span className="v">{formatTokens(taskUsage?.totals.total_tokens ?? null)}</span>
                  </div>
                  <div className="insp-line" title={COST_NOTE}>
                    <span className="k">{t('insp.cost')}</span>
                    <span className="v">{formatCost(taskUsage?.totals.cost_usd ?? null)}</span>
                  </div>
                </div>
              </>
            )}

            <h3 className="dash-sub">{t('insp.project')}</h3>
            <div className="insp-card">
              <div className="insp-line">
                <span className="k">状态</span>
                <span className="v">{t('insp.project.none')}</span>
              </div>
            </div>

            <h3 className="dash-sub">{t('insp.context')}</h3>
            <div className="insp-card">
              <div className="insp-line">
                <span className="k">Context Manager</span>
                <span className="v">{t('insp.notEnabled')}</span>
              </div>
              <div className="insp-line">
                <span className="k">{t('insp.memory')}</span>
                <span className="v">—</span>
              </div>
              <div className="insp-line">
                <span className="k">{t('insp.snapshot')}</span>
                <span className="v">—</span>
              </div>
            </div>
            <div className="insp-note">{t('insp.context.note')}</div>
          </section>

          <section
            className="insp-panel"
            role="tabpanel"
            aria-label={t('insp.settings')}
            inert={panel !== 'settings'}
          >
            <div className="insp-title">{t('insp.settings')}</div>
            <div className="insp-note">
              {t('insp.settings.note')}
            </div>

            <button
              type="button"
              className="perm-summary"
              aria-expanded={permissionOpen}
              aria-controls="permission-options"
              disabled={controlsBusy}
              onClick={() => setPermissionOpen((value) => !value)}
            >
              <span className="perm-summary-label">{t('insp.permission')}</span>
              <span className="perm-summary-value">
                {PERMISSION_OPTIONS.find(([mode]) => (permissionMode ?? 'manual') === mode)?.[1] !==
                undefined
                  ? t(
                      PERMISSION_OPTIONS.find(
                        ([mode]) => (permissionMode ?? 'manual') === mode,
                      )![1],
                    )
                  : t('insp.perm.manual')}
              </span>
              <ChevronDown
                size={14}
                strokeWidth={2}
                className={`perm-chevron${permissionOpen ? ' is-open' : ''}`}
                aria-hidden="true"
              />
            </button>

            <div className="perm-expand" id="permission-options" data-open={permissionOpen}>
              <div className="perm-expand-inner">
                {PERMISSION_OPTIONS.map(([mode, label, description]) => (
                  <button
                    key={mode}
                    type="button"
                    className="ctl-permission"
                    data-active={(permissionMode ?? 'manual') === mode}
                    aria-pressed={(permissionMode ?? 'manual') === mode}
                    disabled={controlsBusy}
                    onClick={() => {
                      if (mode === 'bypassPermissions') {
                        const confirmed = window.confirm(
                          t('insp.perm.confirm'),
                        );

                        if (!confirmed) return;
                      }

                      void choosePermissionMode(mode);
                      setPermissionOpen(false);
                    }}
                  >
                    <span className="ctl-permission-name">{t(label)}</span>
                    <span className="ctl-permission-desc">{t(description)}</span>
                  </button>
                ))}
              </div>
            </div>

            {permissionMode === 'bypassPermissions' ? (
              <div className="insp-note" style={{ color: 'var(--danger)' }}>
                {t('insp.perm.on')}
              </div>
            ) : null}

            <div className="insp-title" style={{ marginTop: 'var(--space-4)' }}>
              本轮
            </div>
            <ConversationControlBar />
          </section>

          <section
            className="insp-panel"
            role="tabpanel"
            aria-label={t('insp.tab.todo')}
            inert={panel !== 'todo'}
          >
            <div className="insp-title">{t('insp.todo.title')}</div>
            {todoFindings.length === 0 ? (
              <div className="insp-note">{t('insp.todo.empty')}</div>
            ) : (
              <div className="insp-card">
                {todoFindings.map((finding) => (
                  <button
                    key={finding.id}
                    type="button"
                    className="insp-line"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      try {
                        sessionStorage.setItem('trinity.board.focus', finding.card_id);
                      } catch {
                        // Storage may be unavailable; the board still opens.
                      }

                      window.location.hash = '#/board';
                    }}
                  >
                    <span className="k">
                      {finding.title}
                      <br />
                      <span className="secondary-text">
                        {t('insp.round').replace('{n}', String(finding.round_no))} · {finding.card_title ?? t('insp.card')}
                      </span>
                    </span>
                    <span className={FINDING_TONE[finding.status]}>
                      {FINDING_LABEL[finding.status]}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="insp-note">
              {t('insp.todo.note')}
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}
