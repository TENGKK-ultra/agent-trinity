import { useEffect, useMemo, useState } from 'react';
import {
  getUsageDaily,
  getUsageSummary,
  type UsageAgentRowDto,
  type UsageDailyRowDto,
  type UsageModelRowDto,
  type UsageSummaryDto,
  type UsageTotalsDto,
} from '../../services/core-api';
import { COST_NOTE, formatCost, formatTokens } from './format';

const AGENTS = [
  { id: '', label: '全部 Agent' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'deepseek', label: 'DeepSeek Harness' },
];

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHART_DAYS = 120;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function totalOf(row: UsageTotalsDto): number {
  return (
    (row.input_tokens ?? 0) +
    (row.output_tokens ?? 0) +
    (row.cache_read_tokens ?? 0) +
    (row.cache_write_tokens ?? 0)
  );
}

interface ChartDay {
  date: string;
  row: UsageDailyRowDto | null;
}

/**
 * Missing days are drawn as gaps, never as zero-cost days: the API omits them
 * on purpose and the chart must not turn "unknown" into "spent nothing".
 */
export function buildChartDays(
  from: string,
  to: string,
  rows: UsageDailyRowDto[],
): ChartDay[] {
  if (from === '' || to === '') {
    return rows.map((row) => ({ date: row.date, row }));
  }

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days: ChartDay[] = [];
  let cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  while (cursor.getTime() <= end.getTime() && days.length < MAX_CHART_DAYS) {
    const key = isoDay(cursor);
    days.push({ date: key, row: byDate.get(key) ?? null });
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return days;
}

const SEGMENTS: Array<{
  key: keyof Pick<
    UsageTotalsDto,
    'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'
  >;
  label: string;
  className: string;
}> = [
  { key: 'input_tokens', label: '输入', className: 'is-input' },
  { key: 'output_tokens', label: '输出', className: 'is-output' },
  { key: 'cache_read_tokens', label: '缓存读', className: 'is-cache-read' },
  { key: 'cache_write_tokens', label: '缓存写', className: 'is-cache-write' },
];

function DailyChart({ days }: { days: ChartDay[] }) {
  const max = Math.max(1, ...days.map((day) => (day.row === null ? 0 : totalOf(day.row))));

  return (
    <div className="usage-chart" role="img" aria-label="每日 Token 用量">
      <div className="usage-chart-bars">
        {days.map(({ date, row }) => {
          const total = row === null ? 0 : totalOf(row);
          const tooltip =
            row === null
              ? `${date} · 无数据`
              : `${date} · 输入 ${formatTokens(row.input_tokens)} · 输出 ${formatTokens(
                  row.output_tokens,
                )} · 缓存读 ${formatTokens(row.cache_read_tokens)} · 成本 ${formatCost(row.cost_usd)}`;

          return (
            <div className="usage-chart-col" key={date} title={tooltip}>
              <div className="usage-chart-track">
                {row !== null && total > 0 ? (
                  <div
                    className="usage-chart-stack"
                    style={{ height: `${Math.max(4, (total / max) * 100)}%` }}
                  >
                    {SEGMENTS.map((segment) => {
                      const value = row[segment.key] ?? 0;
                      if (value <= 0) return null;

                      return (
                        <div
                          key={segment.key}
                          className={`usage-chart-seg ${segment.className}`}
                          style={{ flexGrow: value }}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <span className="usage-chart-label">{date.slice(5)}</span>
            </div>
          );
        })}
      </div>

      <div className="usage-legend">
        {SEGMENTS.map((segment) => (
          <span key={segment.key} className="usage-legend-item">
            <span className={`usage-legend-dot ${segment.className}`} />
            {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function TotalsGrid({ totals }: { totals: UsageTotalsDto }) {
  return (
    <div className="usage-cards">
      <div className="usage-card">
        <span className="usage-card-label">总 Token</span>
        <span className="usage-card-value">{formatTokens(totals.total_tokens)}</span>
      </div>
      <div className="usage-card">
        <span className="usage-card-label">输入（非缓存）</span>
        <span className="usage-card-value">{formatTokens(totals.input_tokens)}</span>
      </div>
      <div className="usage-card">
        <span className="usage-card-label">输出</span>
        <span className="usage-card-value">{formatTokens(totals.output_tokens)}</span>
      </div>
      <div className="usage-card">
        <span className="usage-card-label">缓存读</span>
        <span className="usage-card-value">{formatTokens(totals.cache_read_tokens)}</span>
      </div>
      <div className="usage-card">
        <span className="usage-card-label">缓存写</span>
        <span className="usage-card-value">{formatTokens(totals.cache_write_tokens)}</span>
      </div>
      <div className="usage-card" title={COST_NOTE}>
        <span className="usage-card-label">真实成本（人民币估算）</span>
        <span className="usage-card-value">{formatCost(totals.cost_usd)}</span>
      </div>
    </div>
  );
}

function BreakdownTable<T extends UsageTotalsDto>({
  rows,
  nameOf,
  emptyLabel,
}: {
  rows: T[];
  nameOf: (row: T) => string;
  emptyLabel: string;
}) {
  if (rows.length === 0) return <p className="dash-empty">{emptyLabel}</p>;

  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>输入</th>
          <th>输出</th>
          <th>缓存读</th>
          <th>缓存写</th>
          <th>合计</th>
          <th>成本</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={nameOf(row)}>
            <td>{nameOf(row)}</td>
            <td>{formatTokens(row.input_tokens)}</td>
            <td>{formatTokens(row.output_tokens)}</td>
            <td>{formatTokens(row.cache_read_tokens)}</td>
            <td>{formatTokens(row.cache_write_tokens)}</td>
            <td>{formatTokens(row.total_tokens)}</td>
            <td>{formatCost(row.cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsagePage() {
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => isoDay(new Date(now.getTime() - 13 * DAY_MS)));
  const [to, setTo] = useState(() => isoDay(now));
  const [agent, setAgent] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [model, setModel] = useState('');
  const [summary, setSummary] = useState<UsageSummaryDto | null>(null);
  const [days, setDays] = useState<UsageDailyRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const filters = {
      from,
      to,
      agent: agent === '' ? undefined : agent,
      model: model.trim() === '' ? undefined : model.trim(),
    };

    Promise.all([getUsageSummary(filters), getUsageDaily(filters)])
      .then(([nextSummary, nextDaily]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setDays(nextDaily.days);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError('无法加载用量数据，请检查 Core 后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [from, to, agent, model, reload]);

  const chartDays = buildChartDays(from, to, days);
  const totals = summary?.totals;
  const isEmpty =
    summary !== null &&
    days.length === 0 &&
    totals !== undefined &&
    Object.values(totals).every((value) => value === null);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>用量</h1>
          <p>Token 消耗与真实成本</p>
        </div>
        <div className="usage-filters">
          <label className="usage-field">
            <span>从</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="usage-field">
            <span>到</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="usage-field">
            <span>Agent</span>
            <select value={agent} onChange={(event) => setAgent(event.target.value)}>
              {AGENTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="usage-field">
            <span>配置模型</span>
            <input
              type="text"
              value={modelDraft}
              placeholder="全部"
              onChange={(event) => setModelDraft(event.target.value)}
              onBlur={() => setModel(modelDraft)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setModel(modelDraft);
              }}
            />
          </label>
        </div>
      </div>

      <div className="page-body usage-body">
        {error !== null ? (
          <div className="usage-state">
            <p>{error}</p>
            <button className="btn" onClick={() => setReload((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : loading && summary === null ? (
          <p className="usage-state">正在加载用量…</p>
        ) : isEmpty ? (
          <p className="usage-state">这段时间没有用量记录。</p>
        ) : (
          <>
            {totals !== undefined ? (
              <>
                <TotalsGrid totals={totals} />
                <p className="usage-note">{COST_NOTE}；数据库保留 Provider 上报的美元原值。</p>
              </>
            ) : null}

            <section className="usage-section">
              <header className="usage-section-head">
                <h2>每日用量</h2>
                <span className="dash-muted">按北京时间（UTC+8）分日</span>
              </header>
              <DailyChart days={chartDays} />
            </section>

            <div className="usage-groups">
              <section className="usage-section">
                <header className="usage-section-head">
                  <h2>按 Agent</h2>
                </header>
                <BreakdownTable
                  rows={(summary?.by_agent ?? []) as UsageAgentRowDto[]}
                  nameOf={(row) => AGENT_LABEL[row.agent] ?? row.agent}
                  emptyLabel="没有 Agent 数据"
                />
              </section>

              <section className="usage-section">
                <header className="usage-section-head">
                  <h2>按配置模型</h2>
                </header>
                <BreakdownTable
                  rows={(summary?.by_model ?? []) as UsageModelRowDto[]}
                  nameOf={(row) => row.configured_model ?? '未配置模型'}
                  emptyLabel="没有模型数据"
                />
              </section>
            </div>

            {loading ? <p className="usage-state">正在刷新…</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
