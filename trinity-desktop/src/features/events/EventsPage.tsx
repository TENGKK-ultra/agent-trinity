import { useCallback, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import {
  listEvents,
  type EventFilterDto,
  type EventItemDto,
  type EventPageDto,
} from '../../services/core-api';

const FILTERS: Array<{ key: EventFilterDto; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'task', label: '任务' },
  { key: 'system', label: '系统' },
  { key: 'error', label: '错误' },
];

const PAGE_SIZE = 50;

const SOURCE_LABEL: Record<EventItemDto['source'], string> = {
  task: '任务',
  system: '系统',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function EventsPage() {
  const [filter, setFilter] = useState<EventFilterDto>('all');
  const [items, setItems] = useState<EventItemDto[]>([]);
  const [counts, setCounts] = useState<EventPageDto['counts']>({ task: 0, system: 0, error: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(async (next: EventFilterDto) => {
    setLoading(true);
    setError(null);

    try {
      const page = await listEvents({ filter: next, limit: PAGE_SIZE, offset: 0 });
      setItems(page.items);
      setTotal(page.total);
      setCounts(page.counts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取事件失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFirstPage(filter);
  }, [filter, loadFirstPage]);

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);

    try {
      const page = await listEvents({ filter, limit: PAGE_SIZE, offset: items.length });
      setItems((previous) => [...previous, ...page.items]);
      setTotal(page.total);
      setCounts(page.counts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取事件失败');
    } finally {
      setLoadingMore(false);
    }
  };

  const countOf = (key: EventFilterDto): number => {
    if (key === 'all') return counts.task + counts.system;
    return counts[key];
  };

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>事件</h1>
          <p>Core 自己记下的事：任务开始与结束、进程启动失败、超时、退出异常</p>
        </div>
        <div className="grow" />
        <span className="chip">{loading ? '读取中…' : `共 ${String(total)} 条`}</span>
      </div>

      <div className="page-body">
        <div className="filters">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`chip ev-filter${filter === entry.key ? ' chip-accent' : ''}`}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}
              <span className="ev-count">{countOf(entry.key)}</span>
            </button>
          ))}
        </div>

        {error !== null ? <p className="ev-error">{error}</p> : null}

        <div className="card">
          {loading ? (
            <p className="secondary-text ev-hint">正在读取…</p>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Activity}
              title={filter === 'all' ? '暂无事件' : '这个来源下还没有事件'}
              description={
                filter === 'all'
                  ? '事件由 Core 在跑回合时自己写入：任务开始与结束、进程启动失败、超时、退出异常。跑一次任务就会出现在这里。'
                  : '换一个筛选看看，或者等 Core 跑一次任务。'
              }
            />
          ) : (
            <ul className="ev-list">
              {items.map((item) => (
                <li key={item.id} className={`ev-row${item.failed ? ' ev-row-failed' : ''}`}>
                  <div className="ev-head">
                    <span className="ev-time mono">{formatTime(item.created_at)}</span>
                    <span className={`chip ev-source${item.failed ? ' chip-danger' : ''}`}>
                      {SOURCE_LABEL[item.source]}
                    </span>
                    <span className="ev-where" title={item.conversation_title ?? '（对话已删除）'}>
                      {item.conversation_title ?? '（对话已删除）'}
                    </span>
                    {item.reason !== null ? <span className="ev-reason">{item.reason}</span> : null}
                  </div>
                  <p className="ev-text">{item.content}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {items.length > 0 && items.length < total ? (
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? '加载中…' : `加载更多（还有 ${String(total - items.length)} 条）`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
