import { useEffect, useState } from 'react';
import { roundTone } from '../features/board/format';
import { useCore } from '../hooks/useCoreStatus';
import { getBoardStatus, type BoardStatusDto } from '../services/core-api';
import { coreTarget } from '../services/core-config';

declare const __APP_VERSION__: string;

const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== '' ? __APP_VERSION__ : '0.0.0';

const BOARD_POLL_MS = 5000;

export function StatusBar() {
  const { state } = useCore();
  const target = coreTarget();
  const invalid = target.url === null;
  const [board, setBoard] = useState<BoardStatusDto | null>(null);

  useEffect(() => {
    if (state !== 'connected') {
      setBoard(null);
      return;
    }

    let alive = true;

    const load = async (): Promise<void> => {
      try {
        const next = await getBoardStatus();
        if (alive) setBoard(next);
      } catch {
        // The badge is informational; a failed poll must not break the shell.
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, BOARD_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [state]);

  const label = invalid
    ? '连接配置异常'
    : state === 'connected'
      ? '已连接 Core'
      : state === 'connecting'
        ? '正在连接 Core…'
        : '未连接 Core';
  const dot = invalid
    ? 'dot-danger'
    : state === 'connected'
      ? 'dot-success'
      : state === 'connecting'
        ? 'dot-warning'
        : 'dot-danger';

  const active = board?.active[0] ?? null;
  const limit = board?.cross_round_limit ?? null;

  return (
    <footer className="statusbar">
      <span className="item">
        <span className={`dot ${dot}`} />
        {label}
      </span>
      <span className="item">
        {invalid ? '未选择连接目标' : `${target.display} · ${target.label}环境`}
      </span>
      {limit !== null ? (
        <button
          type="button"
          className={roundTone(limit)}
          style={{ border: 'none', cursor: 'pointer' }}
          onClick={() => {
            window.location.hash = '#/board';
          }}
          title="打开白板；颜色按交叉验证上限分级"
        >
          {active
            ? `交叉验证 ${active.cross_round_used}/${active.cross_round_limit}`
            : `交叉验证上限 ${limit}`}
        </button>
      ) : null}
      <span className="grow" />
      <span className="item">Trinity Desktop v{APP_VERSION}</span>
    </footer>
  );
}
