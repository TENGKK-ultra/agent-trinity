import { useEffect, useState } from 'react';
import { ListChecks, MessagesSquare } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { useCore } from '../../hooks/useCoreStatus';
import { coreTarget } from '../../services/core-config';
import {
  listAgentDirectory,
  listAllTasks,
  listConversations,
  type AgentDirectoryDto,
  type ConversationDto,
  type TaskDto,
} from '../../services/core-api';

interface OverviewData {
  conversations: ConversationDto[];
  conversationTotal: number;
  taskTotal: number;
  runningTotal: number;
  running: TaskDto[];
  agents: AgentDirectoryDto[];
}

function agentState(entry: AgentDirectoryDto): string {
  if (entry.running_conversations > 0) return `运行中 · ${entry.running_conversations}`;
  if (entry.bound_conversations > 0) return `已绑定 · ${entry.bound_conversations}`;
  return '未绑定';
}

export function OverviewPage() {
  const { state } = useCore();
  const connected = state === 'connected';

  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) {
      setData(null);
      setError(null);
      return;
    }

    let alive = true;

    void (async () => {
      try {
        const [conversations, tasks, running, directory] = await Promise.all([
          listConversations({ limit: 5, sort: 'updated', order: 'desc' }),
          listAllTasks({ limit: 1 }),
          listAllTasks({ status: 'running', limit: 5 }),
          listAgentDirectory(),
        ]);

        if (!alive) return;

        setData({
          conversations: conversations.items,
          conversationTotal: conversations.total,
          taskTotal: tasks.total,
          runningTotal: running.total,
          running: running.items,
          agents: directory.items,
        });
        setError(null);
      } catch (err) {
        if (!alive) return;

        setData(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, [connected]);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>总览</h1>
          <p>Trinity 工作台运行概况</p>
        </div>
      </div>

      <div className="page-body">
        {error !== null ? (
          <div className="card">
            <div className="card-body">
              <p className="secondary-text">读取运行概况失败：{error}</p>
            </div>
          </div>
        ) : null}

        <div className="tiles">
          <div className="tile">
            <div className="label">对话</div>
            <div className="value">{data?.conversationTotal ?? '—'}</div>
            <div className="sub">{connected ? '来自 Trinity Core' : '未连接'}</div>
          </div>
          <div className="tile">
            <div className="label">任务</div>
            <div className="value">{data?.taskTotal ?? '—'}</div>
            <div className="sub">全部委派任务</div>
          </div>
          <div className="tile">
            <div className="label">运行中</div>
            <div className="value">{data?.runningTotal ?? '—'}</div>
            <div className="sub">正在执行的 Agent 回合</div>
          </div>
          <div className="tile">
            <div className="label">后端</div>
            <div
              className="value"
              style={{
                fontSize: 'var(--text-lg)',
                color: connected ? 'var(--success)' : 'var(--warning)',
              }}
            >
              {connected ? '已连接' : state === 'connecting' ? '连接中' : '未连接'}
            </div>
            <div className="sub mono">{coreTarget().display}</div>
          </div>
        </div>

        <div className="cols">
          <div className="stack">
            <div className="card">
              <div className="card-head">
                <h2>最近对话</h2>
              </div>
              {data === null || data.conversations.length === 0 ? (
                <EmptyState
                  icon={MessagesSquare}
                  title={connected ? '还没有对话' : '未连接 Trinity Core'}
                  description={
                    connected
                      ? '到「对话」页新建一个，消息会保存在本地数据库。'
                      : '桌面端会持续检测 Core，连上后自动加载。'
                  }
                />
              ) : (
                <div className="card-body">
                  {data.conversations.map((item) => (
                    <div className="row" key={item.id}>
                      <span className="grow">
                        <span className="primary-text">{item.title}</span>
                        <br />
                        <span className="secondary-text">
                          {new Date(item.updated_at).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>正在运行的任务</h2>
              </div>
              {data === null || data.running.length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title="没有正在运行的任务"
                  description="Agent 开始执行后，这里会显示真实的运行记录。"
                />
              ) : (
                <div className="card-body">
                  {data.running.map((task) => (
                    <div className="row" key={task.id}>
                      <span className="grow">
                        <span className="primary-text">{task.title}</span>
                        <br />
                        <span className="secondary-text">
                          {task.target_agent} · {task.conversation_title ?? '当前工作区'}
                        </span>
                      </span>
                      <span className="chip chip-accent">{task.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Agent 状态</h2>
            </div>
            <div className="card-body">
              {data === null ? (
                <p className="secondary-text">{connected ? '正在读取…' : '未连接 Core'}</p>
              ) : (
                data.agents.map((entry) => (
                  <div className="row" key={entry.agent}>
                    <span className="dot" />
                    <span className="grow">
                      <span className="primary-text">{entry.display_name}</span>
                      <br />
                      <span className="secondary-text">{agentState(entry)}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
