import { useCallback, useEffect, useState } from 'react';
import { FolderClosed, Plus } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { useCore } from '../../hooks/useCoreStatus';
import {
  createProject,
  getProject,
  listConversations,
  listProjects,
  setProjectBackground,
  setProjectMember,
  type ConversationDto,
  type ProjectDetailDto,
  type ProjectDto,
} from '../../services/core-api';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function ProjectsPage() {
  const { state } = useCore();
  const connected = state === 'connected';

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetailDto | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (): Promise<ProjectDto[]> => {
    const page = await listProjects();
    setProjects(page.items);

    return page.items;
  }, []);

  useEffect(() => {
    if (!connected) {
      setProjects([]);
      setConversations([]);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const [list, page] = await Promise.all([
          listProjects(),
          listConversations({ limit: 100, sort: 'updated', order: 'desc' }),
        ]);

        if (!alive) return;

        setProjects(list.items);
        setConversations(page.items);
        setSelectedId((current) => current ?? list.items[0]?.id ?? null);
      } catch (caught) {
        if (alive) setError(messageOf(caught));
      }
    })();

    return () => {
      alive = false;
    };
  }, [connected]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const next = await getProject(selectedId);
        if (alive) {
          setDetail(next);
          setError(null);
        }
      } catch (caught) {
        if (alive) setError(messageOf(caught));
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedId]);

  const handleCreate = async (): Promise<void> => {
    if (busy || name.trim() === '') return;

    setBusy(true);

    try {
      const created = await createProject({ name: name.trim() });
      setName('');
      await loadList();
      setSelectedId(created.id);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleMember = async (conversation: ConversationDto): Promise<void> => {
    if (selectedId === null || busy) return;

    setBusy(true);

    try {
      const next = await setProjectMember(
        selectedId,
        conversation.id,
        conversation.project_id !== selectedId,
      );
      setDetail(next);
      await loadList();

      // Membership changed for one conversation; reload the rows so the
      // "属于其他项目" hint matches what the server now holds.
      const page = await listConversations({ limit: 100, sort: 'updated', order: 'desc' });
      setConversations(page.items);
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleBackground = async (conversation: ConversationDto): Promise<void> => {
    if (selectedId === null || detail === null || busy) return;

    setBusy(true);

    try {
      const next = await setProjectBackground(
        selectedId,
        conversation.id,
        !detail.background.includes(conversation.id),
      );
      setDetail({ ...detail, background: next.background });
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const selected = detail?.project ?? projects.find((project) => project.id === selectedId) ?? null;
  const backgroundIds = new Set(detail?.background ?? []);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>项目</h1>
          <p>项目把对话归在一起，并选定哪些对话作为背景资料</p>
        </div>
        <div className="grow" />
        <input
          className="input"
          aria-label="新项目名称"
          placeholder="新项目名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={{ maxWidth: 220 }}
        />
        <button
          className="btn btn-primary"
          onClick={() => void handleCreate()}
          disabled={!connected || busy || name.trim() === ''}
        >
          <Plus size={15} strokeWidth={1.8} />
          新建项目
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

        {!connected ? (
          <div className="card">
            <EmptyState
              icon={FolderClosed}
              title="未连接 Trinity Core"
              description="连上 Core 后，这里会显示真实项目。"
            />
          </div>
        ) : projects.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={FolderClosed}
              title="还没有项目"
              description="在右上角输入名称建一个，再把对话归进去。"
            />
          </div>
        ) : (
          <div className="cols">
            <div className="card">
              <div className="card-head">
                <h2>项目</h2>
                <span className="chip">{projects.length}</span>
              </div>
              <div className="card-body">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="row"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: project.id === selectedId ? 'var(--accent-soft)' : 'transparent',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: 'var(--space-2)',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <span className="grow">
                      <span className="primary-text">{project.name}</span>
                      <br />
                      <span className="secondary-text">
                        对话 {project.conversation_count ?? 0} · 背景{' '}
                        {project.background_count ?? 0}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              {selected === null ? (
                <EmptyState
                  icon={FolderClosed}
                  title="选一个项目"
                  description="右侧显示归属与背景设置。"
                />
              ) : (
                <>
                  <div className="card-head">
                    <h2>{selected.name}</h2>
                    <span className="chip">归属 {detail?.members.length ?? 0}</span>
                  </div>
                  <div className="card-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <p className="secondary-text">
                      归属：这个项目的对话。背景：把选定对话的最近内容，以资料形式拼进本项目对话的回合提示词（有字数上限，平台不判断相关性）。
                    </p>

                    <div>
                      <div className="secondary-text">对话设置</div>
                      {conversations.length === 0 ? (
                        <p className="secondary-text">还没有对话。</p>
                      ) : (
                        conversations.map((conversation) => {
                          const isMember = conversation.project_id === selected.id;
                          const isBackground = backgroundIds.has(conversation.id);

                          return (
                            <div className="row" key={conversation.id}>
                              <span className="grow">
                                <span className="primary-text">{conversation.title}</span>
                                <br />
                                <span className="secondary-text">
                                  {formatDay(conversation.updated_at)}
                                  {conversation.project_id !== null && !isMember
                                    ? ' · 属于其他项目'
                                    : ''}
                                </span>
                              </span>
                              <label
                                className="secondary-text"
                                style={{ display: 'inline-flex', gap: 4 }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isMember}
                                  disabled={busy}
                                  onChange={() => void toggleMember(conversation)}
                                />
                                归属
                              </label>
                              <label
                                className="secondary-text"
                                style={{ display: 'inline-flex', gap: 4 }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isBackground}
                                  disabled={busy}
                                  onChange={() => void toggleBackground(conversation)}
                                />
                                背景
                              </label>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
