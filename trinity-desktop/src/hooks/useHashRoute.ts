import { useCallback, useEffect, useState } from 'react';
import type { PageId } from '../types';
import { PAGE_IDS } from '../types';

export interface HashRoute {
  page: PageId;
  /** `#/conversations/<id>` 里的 `<id>`，用于深链到某一条对话。 */
  param: string | null;
}

function parseHash(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, '');
  const [id, ...rest] = raw.split('/');
  const page = (PAGE_IDS as string[]).includes(id ?? '') ? (id as PageId) : 'overview';
  const value = rest[0];

  if (value === undefined || value === '') {
    return { page, param: null };
  }

  try {
    return { page, param: decodeURIComponent(value) };
  } catch {
    return { page, param: null };
  }
}

function routeHash(page: PageId, param?: string | null): string {
  return param ? `#/${page}/${encodeURIComponent(param)}` : `#/${page}`;
}

export function useHashRoute(): HashRoute & {
  navigate: (next: PageId, param?: string | null) => void;
} {
  const [route, setRoute] = useState<HashRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: PageId, param?: string | null) => {
    const target = routeHash(next, param);
    if (window.location.hash === target) return;
    window.location.hash = target;
  }, []);

  return { ...route, navigate };
}
