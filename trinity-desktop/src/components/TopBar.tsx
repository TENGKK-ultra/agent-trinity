import { useEffect, useState } from 'react';
import { Monitor, Moon, PanelLeft, PanelRight, Search, Sun } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ResolvedTheme, ThemeChoice } from '../types';
import { useT } from '../i18n';

function inTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Hand-drawn window glyphs: round caps, a light bow, and enough stroke to read
 * at 14px. Straight strokes read as system chrome; these read as part of the
 * app's own surface.
 */
function MinimizeGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M3 7.3C5.6 6.6 8.4 6.6 11 7.3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
      />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect
        x={3.2}
        y={3.2}
        width={7.6}
        height={7.6}
        rx={2.4}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
      />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M5.8 2.9h3.1a2.2 2.2 0 0 1 2.2 2.2v3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <rect
        x={2.9}
        y={5.8}
        width={5.3}
        height={5.3}
        rx={1.8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M4.2 4.4C6.1 6.2 7.9 7.8 9.8 9.6M9.8 4.4C7.9 6.2 6.1 7.8 4.2 9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
      />
    </svg>
  );
}

interface TopBarProps {
  themeChoice: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  onCycleTheme: () => void;
  onToggleNav: () => void;
  onToggleInspector: () => void;
  onOpenSearch: () => void;
}

export function TopBar({
  themeChoice,
  resolvedTheme,
  onCycleTheme,
  onToggleNav,
  onToggleInspector,
  onOpenSearch,
}: TopBarProps) {
  const t = useT();
  const themeLabel =
    themeChoice === 'system' ? '跟随系统' : themeChoice === 'light' ? '浅色' : '深色';
  const ThemeIcon = themeChoice === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun;

  // The window has no decorations now, so the bar has to follow maximise state
  // even when the system changes it behind our back (Win+Up, Snap, double click).
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauriRuntime()) return;

    const win = getCurrentWindow();
    let cancelled = false;

    const sync = async (): Promise<void> => {
      try {
        const next = await win.isMaximized();
        if (!cancelled) setMaximized(next);
      } catch {
        // A failed probe must not break the bar.
      }
    };

    void sync();

    const unlisten = win.onResized(() => {
      void sync();
    });

    return () => {
      cancelled = true;
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }, []);

  const minimize = (): void => {
    if (inTauriRuntime()) void getCurrentWindow().minimize();
  };

  const toggleMaximize = (): void => {
    if (inTauriRuntime()) void getCurrentWindow().toggleMaximize();
  };

  const close = (): void => {
    if (inTauriRuntime()) void getCurrentWindow().close();
  };

  return (
    <header className="topbar" data-tauri-drag-region="deep">
      <div className="topbar-tint" aria-hidden="true" />
      <div className="brand">
        <div className="brand-mark" />
        Trinity
      </div>

      {/* The project name gets a fixed budget: past it the text fades out
          instead of being cut. Hovering the group widens it and the toggle
          gives way, so the two never overlap. */}
      <div className="crumb-group">
        <div className="crumb">
          <span>{t('topbar.noProject')}</span>
        </div>
        <button
          className="icon-btn"
          onClick={onToggleNav}
          title={t('topbar.toggleNav')}
        >
          <PanelLeft size={17} strokeWidth={1.6} />
        </button>
      </div>

      <div className="top-spacer" />

      <button
        type="button"
        className="searchbox"
        onClick={onOpenSearch}
        title={t('topbar.search.title')}
        aria-label={t('topbar.search.aria')}
      >
        <Search size={14} strokeWidth={1.6} />
        <span>{t('topbar.search')}</span>
        <kbd>Ctrl K</kbd>
      </button>

      <button
        className="icon-btn"
        onClick={onCycleTheme}
        title={`外观：${themeLabel}（点击切换）`}
        aria-label={`外观：${themeLabel}`}
      >
        <ThemeIcon size={17} strokeWidth={1.6} />
      </button>

      <button className="icon-btn" onClick={onToggleInspector} title={t('topbar.toggleInspector')}>
        <PanelRight size={17} strokeWidth={1.6} />
      </button>

      <div className="win-controls">
        <button
          type="button"
          className="win-btn"
          onClick={minimize}
          aria-label="最小化"
        >
          <MinimizeGlyph />
        </button>
        <button
          type="button"
          className="win-btn"
          onClick={toggleMaximize}
          aria-label={maximized ? '还原' : '最大化'}
        >
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </button>
        <button
          type="button"
          className="win-btn is-close"
          onClick={close}
          aria-label="关闭"
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="topbar-feather" aria-hidden="true">
        <div className="topbar-feather-tint" />
      </div>
    </header>
  );
}
