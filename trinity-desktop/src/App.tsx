import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ClosePrompt } from './components/ClosePrompt';
import { isTauriRuntime } from './services/core-config';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { ActivityPage } from './features/activity/ActivityPage';
import { AgentsPage } from './features/agents/AgentsPage';
import { BoardPage } from './features/board/BoardPage';
import { CollabPage } from './features/collab/CollabPage';
import { ConversationsPage } from './features/conversations/ConversationsPage';
import { SearchPalette } from './components/SearchPalette';
import { EventsPage } from './features/events/EventsPage';
import { MemoryPage } from './features/memory/MemoryPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { UsagePage } from './features/usage/UsagePage';
import { ConversationControlsProvider } from './hooks/useConversationControls';
import { CoreProvider } from './hooks/useCoreStatus';
import { useHashRoute } from './hooks/useHashRoute';
import { InspectorProvider, useInspector } from './hooks/useInspector';
import { useTheme } from './hooks/useTheme';

const COMPACT_QUERY = '(max-width: 1180px)';

export default function App() {
  return (
    <CoreProvider>
      <InspectorProvider>
        <ConversationControlsProvider>
          <AppShell />
        </ConversationControlsProvider>
      </InspectorProvider>
    </CoreProvider>
  );
}

function AppShell() {
  const { page, param, navigate } = useHashRoute();
  const { selectedTask } = useInspector();
  const { choice, resolved, setChoice, cycle } = useTheme();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [inspCollapsed, setInspCollapsed] = useState(false);
  // Below the breakpoint the inspector is an overlay that starts closed, so the
  // same toolbar button means "collapse the column" on wide and "open the
  // drawer" on narrow.
  const [compact, setCompact] = useState(
    () => window.matchMedia?.(COMPACT_QUERY)?.matches ?? false,
  );
  const [inspOpen, setInspOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl/Cmd+K 打开全局搜索，Esc 由面板自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The window starts hidden behind the splash. Tell it the panel is laid out
  // and interactive, so the intro can end at the right moment on any machine.
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const id = window.setTimeout(() => {
      void invoke('main_ready');
    }, 450);

    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.(COMPACT_QUERY);
    if (!query) return;

    const onChange = (event: MediaQueryListEvent): void => setCompact(event.matches);
    setCompact(query.matches);
    query.addEventListener('change', onChange);

    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggleNav = useCallback(() => setNavCollapsed((value) => !value), []);
  const toggleInspector = useCallback(() => {
    if (compact) setInspOpen((value) => !value);
    else setInspCollapsed((value) => !value);
  }, [compact]);

  // Selecting a task must reveal the drawer, otherwise the click looks like it
  // did nothing — on wide it may have been collapsed, on narrow it starts closed.
  useEffect(() => {
    if (selectedTask === null) return;

    if (compact) setInspOpen(true);
    else setInspCollapsed(false);
  }, [compact, selectedTask]);

  useEffect(() => {
    if (!compact || !inspOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // A dialog opened from the page is the topmost layer; Esc belongs to it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;

      if (event.key === 'Escape') setInspOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [compact, inspOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.shiftKey) return;
      if (event.key !== 'b' && event.key !== 'B') return;

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      event.preventDefault();
      toggleNav();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleNav]);

  const className = [
    'app',
    navCollapsed ? 'nav-collapsed' : '',
    !compact && inspCollapsed ? 'insp-collapsed' : '',
    compact && inspOpen ? 'insp-overlay-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const renderPage = () => {
    switch (page) {
      case 'projects':
        return <ProjectsPage />;
      case 'conversations':
        return <ConversationsPage initialConversationId={param} />;
      case 'board':
        return <BoardPage />;
      case 'collab':
        return <CollabPage />;
      case 'agents':
        return <AgentsPage />;
      case 'tasks':
        return <ActivityPage onOpenUsage={() => navigate('usage')} />;
      case 'usage':
        return <UsagePage />;
      case 'events':
        return <EventsPage />;
      case 'memory':
        return <MemoryPage />;
      case 'settings':
        return <SettingsPage themeChoice={choice} onThemeChange={setChoice} />;
      case 'overview':
      default:
        return <OverviewPage />;
    }
  };

  return (
    <div className={className}>
      <TopBar
        themeChoice={choice}
        resolvedTheme={resolved}
        onCycleTheme={cycle}
        onToggleNav={toggleNav}
        onToggleInspector={toggleInspector}
        onOpenSearch={() => setSearchOpen(true)}
      />
      <Sidebar page={page} onNavigate={navigate} />
      <main className="main">{renderPage()}</main>
      {compact && inspOpen ? (
        <div className="insp-scrim" role="presentation" onClick={() => setInspOpen(false)} />
      ) : null}
      <Inspector />
      <StatusBar />
      <ClosePrompt />
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenConversation={(id) => navigate('conversations', id)}
      />
    </div>
  );
}
