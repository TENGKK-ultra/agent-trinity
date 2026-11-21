import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchAll, type SearchResultDto } from '../services/core-api';

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

interface Entry {
  key: string;
  kind: 'conversation' | 'message';
  conversationId: string;
  title: string;
  detail: string;
}

const DEBOUNCE_MS = 180;

function toEntries(result: SearchResultDto | null): Entry[] {
  if (result === null) return [];

  return [
    ...result.conversations.map((hit) => ({
      key: `c-${hit.id}`,
      kind: 'conversation' as const,
      conversationId: hit.id,
      title: hit.title,
      detail: '',
    })),
    ...result.messages.map((hit) => ({
      key: `m-${hit.message_id}`,
      kind: 'message' as const,
      conversationId: hit.conversation_id,
      title: hit.conversation_title,
      detail: hit.snippet,
    })),
  ];
}

export function SearchPalette({ open, onClose, onOpenConversation }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResultDto | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = toEntries(result);

  // 面板从顶栏那个搜索框底下长出来，所以位置要跟着它量。
  useEffect(() => {
    if (!open) return;

    const measure = (): void => {
      const box = document.querySelector('.searchbox')?.getBoundingClientRect();
      if (!box) return;

      // 面板右边缘对齐搜索框右边缘——从框底下长出来的感觉才成立
      const width = Math.min(Math.max(box.width, 520), window.innerWidth - 24);
      const left = Math.min(Math.max(12, box.right - width), window.innerWidth - width - 12);
      setAnchor({ left, top: box.bottom + 8, width });
    };

    measure();
    setActive(0);
    window.addEventListener('resize', measure);

    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);

    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const trimmed = query.trim();
    if (trimmed === '') {
      setResult(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = window.setTimeout(() => {
      void searchAll(trimmed)
        .then((page) => {
          if (cancelled) return;
          setResult(page);
          setActive(0);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : '搜索失败');
          setResult(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

  const choose = (entry: Entry | undefined): void => {
    if (entry === undefined) return;
    onOpenConversation(entry.conversationId);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (entries.length === 0 ? 0 : (current + 1) % entries.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (entries.length === 0 ? 0 : (current - 1 + entries.length) % entries.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(entries[active]);
    }
  };

  const conversations = entries.filter((entry) => entry.kind === 'conversation');
  const messages = entries.filter((entry) => entry.kind === 'message');

  return (
    <div className="search-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="search-panel"
        role="dialog"
        aria-label="全局搜索"
        style={
          anchor === null
            ? undefined
            : { left: anchor.left, top: anchor.top, width: anchor.width }
        }
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="search-field">
          <Search size={15} strokeWidth={1.7} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索对话标题和聊过的内容"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="search-results">
          {loading ? <p className="search-hint">搜索中…</p> : null}
          {error !== null ? <p className="search-hint search-hint-error">{error}</p> : null}
          {!loading && error === null && query.trim() !== '' && entries.length === 0 ? (
            <p className="search-hint">没有找到「{query.trim()}」</p>
          ) : null}
          {query.trim() === '' ? (
            <p className="search-hint">输入关键词，回车打开第一条结果</p>
          ) : null}

          {conversations.length > 0 ? (
            <div className="search-group">
              <div className="search-group-title">对话</div>
              {conversations.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`search-item${entries[active]?.key === entry.key ? ' search-item-active' : ''}`}
                  onMouseEnter={() => setActive(entries.findIndex((item) => item.key === entry.key))}
                  onClick={() => choose(entry)}
                >
                  <span className="search-item-title">{entry.title}</span>
                </button>
              ))}
            </div>
          ) : null}

          {messages.length > 0 ? (
            <div className="search-group">
              <div className="search-group-title">聊过的内容</div>
              {messages.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`search-item${entries[active]?.key === entry.key ? ' search-item-active' : ''}`}
                  onMouseEnter={() => setActive(entries.findIndex((item) => item.key === entry.key))}
                  onClick={() => choose(entry)}
                >
                  <span className="search-item-title">{entry.title}</span>
                  <span className="search-item-detail">{entry.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
