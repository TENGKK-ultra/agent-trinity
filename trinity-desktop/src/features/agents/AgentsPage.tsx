import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentMark } from '../../components/AgentMark';
import { EmptyState } from '../../components/EmptyState';
import { useCore } from '../../hooks/useCoreStatus';
import { listAgentDirectory, type AgentDirectoryDto } from '../../services/core-api';

const REFRESH_MS = 5000;

function statusOf(entry: AgentDirectoryDto): { label: string; tone: string } {
  if (entry.running_conversations > 0) {
    return { label: `运行中 · ${entry.running_conversations}`, tone: 'chip-accent' };
  }

  if (entry.bound_conversations > 0) {
    return { label: `已绑定 · ${entry.bound_conversations}`, tone: '' };
  }

  return { label: '未绑定', tone: 'chip-warning' };
}

function recentAt(value: string | null): string {
  return value === null
    ? '—'
    : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function AgentsPage() {
  const { state } = useCore();
  const connected = state === 'connected';

  const [items, setItems] = useState<AgentDirectoryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) {
      setItems(null);
      setError(null);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const page = await listAgentDirectory();

        if (!alive) return;

        setItems(page.items);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [connected]);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Agent</h1>
          <p>执行引擎的绑定与运行状态</p>
        </div>
        <div className="grow" />
        <span className={`chip${connected ? '' : ' chip-warning'}`}>
          {connected ? '来自 Trinity Core' : '未连接'}
        </span>
      </div>

      <div className="page-body">
        {error !== null ? (
          <div className="card">
            <div className="card-body">
              <p className="secondary-text">读取 Agent 目录失败：{error}</p>
            </div>
          </div>
        ) : items === null ? (
          <div className="card">
            <EmptyState
              icon={Bot}
              title={connected ? '正在读取 Agent 状态' : '未连接 Trinity Core'}
              description={
                connected
                  ? '目录会随 Core 的状态自动刷新。'
                  : '桌面端会持续检测 Core，连上后自动加载。'
              }
            />
          </div>
        ) : (
          <div className="agent-grid">
            {items.map((entry) => {
              const status = statusOf(entry);

              return (
                <div className="agent-card" key={entry.agent}>
                  <div className="agent-top">
                    <div className={`agent-avatar is-${entry.agent}`} aria-hidden="true">
                      <AgentMark name={entry.agent} size={20} />
                    </div>
                    <div>
                      <div className="agent-name">{entry.display_name}</div>
                      <div className="agent-sub">{entry.agent}</div>
                    </div>
                    <div style={{ marginLeft: 'auto' }}>
                      <span className={`chip${status.tone === '' ? '' : ` ${status.tone}`}`}>
                        {status.label}
                      </span>
                    </div>
                  </div>
                  <div className="agent-rows">
                    <div className="kv">
                      <span className="k">参与中的工作区</span>
                      <span className="v">{entry.participating_conversations}</span>
                    </div>
                    <div className="kv">
                      <span className="k">运行中</span>
                      <span className="v">{entry.running_conversations}</span>
                    </div>
                    <div className="kv">
                      <span className="k">隔离</span>
                      <span className="v">
                        {entry.quarantined_conversations > 0
                          ? entry.quarantined_conversations
                          : '无'}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">最近活动</span>
                      <span className="v">{recentAt(entry.last_seen_at)}</span>
                    </div>
                    <div className="kv">
                      <span className="k">工作目录</span>
                      <span className="v">{entry.cwd ?? '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">模型</span>
                      <span className="v">{entry.model ?? '默认'}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="card-body">
            <p className="secondary-text">
              这里只展示真实状态：哪些 Agent 已绑定、参与多少工作区、是否在运行。
              能力标签与白板工具属于 0.2.0 的后续阶段，接入前不会出现任何虚构的能力评分。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
