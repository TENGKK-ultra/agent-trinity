import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AGENT_LABEL, AGENT_ORDER } from '../features/conversations/agents';
import { useConversationControls } from '../hooks/useConversationControls';
import {
  createWorkspace,
  listWorkspaces,
  type AgentKind,
  type WorkspaceDto,
} from '../services/core-api';

const MODES = [
  ['team', '团队', '只有 Codex 分发，Claude 与 DSH 待命'],
  ['broadcast', '全员', '点亮的 Agent 各自回答，不做分工'],
  ['codex', 'Codex 执行', '只叫 Codex，它亲自执行，团队规则暂停'],
] as const;

function statusOf(
  session: { status: string; active: boolean; participating: boolean } | null,
): string {
  if (session === null) return '未连接';
  if (session.status === 'running') return '执行中';
  if (session.status === 'error') return '上次失败';
  if (session.active) return '当前使用';
  return session.participating ? '已加入' : '已绑定';
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;

  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }

  return String(value);
}

/**
 * The per-round switches, shown in the right sidebar: which agents take part,
 * the directory each one works in, and how the next message is routed. The
 * conversation page owns the sending; this bar only edits the shared settings.
 */
export function ConversationControlBar(): ReactElement | null {
  const {
    conversationId,
    agentState,
    sendMode,
    chooseSendMode,
    toggleAgent,
    bindToWorkspace,
    unbind,
    busy,
    error,
    mentionRef,
  } = useConversationControls();

  const pressTimer = useRef<number | null>(null);
  const pressFired = useRef(false);
  const [dialogKind, setDialogKind] = useState<AgentKind | null>(null);
  const [resolving, setResolving] = useState<AgentKind | null>(null);

  if (conversationId === null) return null;

  const cancelPress = (): void => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  /**
   * Joining should not ask every time: an agent has a workspace named after it
   * under the default root, and that is where its new conversations go. The
   * picker only appears when no such workspace exists yet.
   */
  const openOrBind = async (kind: AgentKind): Promise<void> => {
    setResolving(kind);

    try {
      const page = await listWorkspaces();
      const root = page.default_root.replace(/[\\/]+$/, '');
      const canonical =
        root === ''
          ? null
          : page.items.find(
              (workspace) => normalizePath(workspace.path) === normalizePath(`${root}\\${kind}`),
            );

      if (canonical) {
        await bindToWorkspace(kind, canonical.path);
        return;
      }
    } catch {
      // The picker is still usable when the list cannot be read.
    } finally {
      setResolving(null);
    }

    setDialogKind(kind);
  };

  return (
    <div className="insp-controls is-embedded" aria-label="本轮设置">
      <div className="ctl-agents">
        {AGENT_ORDER.map((kind) => {
          const session = agentState?.bindings.find((row) => row.agent === kind) ?? null;
          const status = statusOf(session);

          return (
            <div className="ctl-agent-block" key={kind}>
              <button
                type="button"
                className="ctl-agent"
                data-active={session?.participating === true}
                data-current={session?.active === true}
                aria-label={`${AGENT_LABEL[kind]} · ${status}`}
                aria-pressed={session?.participating === true}
                disabled={busy || resolving !== null}
                title={
                  session
                    ? '点击切换本轮参与'
                    : '点击加入本轮；没有默认工作区时会先让你选'
                }
                onClick={() => {
                  if (pressFired.current) {
                    pressFired.current = false;
                    return;
                  }

                  if (session === null) {
                    void openOrBind(kind);
                    return;
                  }

                  void toggleAgent(kind);
                }}
                onPointerDown={() => {
                  pressFired.current = false;
                  pressTimer.current = window.setTimeout(() => {
                    pressFired.current = true;
                    mentionRef.current?.(kind);
                  }, 550);
                }}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
                onContextMenu={(event) => {
                  event.preventDefault();
                  mentionRef.current?.(kind);
                }}
              >
                <span className="ctl-agent-name">
                  <span className="ctl-dot" aria-hidden="true" />
                  {AGENT_LABEL[kind]}
                </span>
                <span className="ctl-agent-state">{status}</span>
              </button>

              <div className="ctl-workspace">
                <span
                  className={`ctl-workspace-path${session?.cwd ? '' : ' is-missing'}`}
                  title={session?.cwd ?? '还没有工作区'}
                >
                  {session?.cwd ?? '未设置工作区'}
                </span>
                <button
                  type="button"
                  className="ctl-workspace-edit"
                  onClick={() => setDialogKind(kind)}
                  disabled={busy}
                >
                  {session?.cwd ? '更换' : '选择'}
                </button>
              </div>
            </div>
          );
        })}

        {agentState?.active_agent ? (
          <button
            type="button"
            className="ctl-unbind"
            onClick={() => void unbind()}
            disabled={busy}
          >
            解绑当前
          </button>
        ) : null}
      </div>

      <div className="ctl-modes" role="group" aria-label="发送方式">
        {MODES.map(([mode, label, title]) => (
          <button
            key={mode}
            type="button"
            className={`btn ${sendMode === mode ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => chooseSendMode(mode)}
            title={title}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <div className="insp-note">{error}</div> : null}

      {dialogKind !== null
        ? createPortal(
            <WorkspaceDialog kind={dialogKind} onClose={() => setDialogKind(null)} />,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Picking a directory is a required step before an agent can take a turn, so the
 * dialog both lists what the user already named and creates a new folder.
 */
function WorkspaceDialog({ kind, onClose }: { kind: AgentKind; onClose: () => void }) {
  const { bindToWorkspace } = useConversationControls();
  const [items, setItems] = useState<WorkspaceDto[] | null>(null);
  const [defaultRoot, setDefaultRoot] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(`${AGENT_LABEL[kind]} 工作区`);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;

    void listWorkspaces()
      .then((page) => {
        if (!alive) return;

        setItems(page.items);
        setDefaultRoot(page.default_root);

        const root = page.default_root.replace(/[\\/]+$/, '');
        const suggestion = root === '' ? '' : `${root}\\${kind}`;
        setPath((current) => (current === '' ? suggestion : current));
      })
      .catch(() => {
        if (!alive) return;

        setItems([]);
        setLoadError('工作区列表读取失败');
      });

    return () => {
      alive = false;
    };
  }, [kind]);

  const choose = async (target: string): Promise<void> => {
    setBusy(true);
    const failure = await bindToWorkspace(kind, target);
    setBusy(false);

    if (failure === null) onClose();
    else setLoadError(failure);
  };

  const createThenChoose = async (): Promise<void> => {
    setBusy(true);
    setLoadError(null);

    try {
      const created = await createWorkspace({ name: name.trim(), path: path.trim() });
      const failure = await bindToWorkspace(kind, created.path);

      if (failure === null) onClose();
      else setLoadError(failure);
    } catch (caught) {
      setLoadError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dash-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="dash-modal ws-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${AGENT_LABEL[kind]} 的工作区`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dash-modal-head">
          <h2>{AGENT_LABEL[kind]} 的工作区</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="dash-modal-body ws-body">
          <p className="ws-hint">
            Agent 的回合在这个目录里执行。选一个已有的工作区，或新建一个。
          </p>

          {items === null ? (
            <p className="ws-hint">读取中…</p>
          ) : items.length === 0 ? (
            <p className="ws-hint">还没有工作区，新建一个即可。</p>
          ) : (
            <div className="ws-list">
              {items.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="ws-item"
                  onClick={() => void choose(workspace.path)}
                  disabled={busy}
                >
                  <span className="ws-name">{workspace.name}</span>
                  <span className="ws-path mono">{workspace.path}</span>
                </button>
              ))}
            </div>
          )}

          <div className="ws-create">
            <div className="ws-create-title">新建工作区</div>
            <input
              className="input"
              aria-label="工作区名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="名称"
            />
            <input
              className="input mono"
              aria-label="工作区目录"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="Absolute path, e.g. D:\workspaces\claude"
            />
            <p className="ws-hint">
              目录不存在时会自动创建；不能选在 Trinity 引擎目录里面。
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void createThenChoose()}
              disabled={busy || name.trim() === '' || path.trim() === ''}
            >
              新建并选择
            </button>
          </div>

          {loadError ? <p className="ws-hint is-error">{loadError}</p> : null}
          {defaultRoot === '' ? null : (
            <p className="ws-hint mono">默认位置：{defaultRoot}</p>
          )}
        </div>
      </div>
    </div>
  );
}
