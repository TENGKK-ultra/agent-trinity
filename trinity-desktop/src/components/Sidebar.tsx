import {
  Activity,
  BarChart3,
  Bot,
  ClipboardList,
  Database,
  FolderClosed,
  Gauge,
  LayoutDashboard,
  MessagesSquare,
  Network,
  Settings,
} from 'lucide-react';
import type { ComponentType, CSSProperties, ReactElement } from 'react';
import type { PageId } from '../types';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/messages';

interface NavItem {
  id: PageId;
  label: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** The avatar needs a couple more pixels than a 17px line icon to read. */
  iconSize?: number;
}

const MAIN_ITEMS: NavItem[] = [
  { id: 'overview', label: 'nav.overview', icon: LayoutDashboard },
  { id: 'projects', label: 'nav.projects', icon: FolderClosed },
  { id: 'conversations', label: 'nav.conversations', icon: MessagesSquare },
  { id: 'board', label: 'nav.board', icon: ClipboardList },
  { id: 'collab', label: 'nav.collab', icon: Network },
];

const WORKBENCH_ITEMS: NavItem[] = [
  { id: 'agents', label: 'nav.agents', icon: Bot },
  { id: 'tasks', label: 'nav.tasks', icon: Gauge },
  { id: 'usage', label: 'nav.usage', icon: BarChart3 },
  { id: 'events', label: 'nav.events', icon: Activity },
  { id: 'memory', label: 'nav.memory', icon: Database },
];

/** One span per character so the label can reveal letter by letter. */
function Label({ text }: { text: string }): ReactElement {
  return (
    <>
      {[...text].map((char, index) => (
        <span
          key={`${char}-${index}`}
          className="nav-char"
          style={{ '--i': index } as CSSProperties}
        >
          {char}
        </span>
      ))}
    </>
  );
}

interface SidebarProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
}

export function Sidebar({ page, onNavigate }: SidebarProps) {
  const t = useT();

  const renderItem = (item: NavItem): ReactElement => {
    const Icon = item.icon;
    const active = page === item.id;
    return (
      <button
        key={item.id}
        className="nav-item"
        onClick={() => onNavigate(item.id)}
        aria-current={active ? 'page' : undefined}
        title={t(item.label)}
      >
        <Icon size={item.iconSize ?? 17} strokeWidth={1.6} />
        <span>
          <Label text={t(item.label)} />
        </span>
      </button>
    );
  };

  return (
    <nav className="nav" aria-label={t('nav.main')}>
      {MAIN_ITEMS.map(renderItem)}

      <div className="nav-group">
        <Label text={t('nav.workbench')} />
      </div>
      {WORKBENCH_ITEMS.map(renderItem)}

      <div className="nav-foot" />
      {renderItem({ id: 'settings', label: 'nav.settings', icon: Settings })}
    </nav>
  );
}
