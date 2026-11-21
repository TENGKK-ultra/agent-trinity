export type PageId =
  | 'overview'
  | 'projects'
  | 'conversations'
  | 'board'
  | 'collab'
  | 'agents'
  | 'tasks'
  | 'usage'
  | 'events'
  | 'memory'
  | 'settings';

export interface NavEntry {
  id: PageId;
  label: string;
}

export const PAGE_IDS: PageId[] = [
  'overview',
  'projects',
  'conversations',
  'board',
  'collab',
  'agents',
  'tasks',
  'usage',
  'events',
  'memory',
  'settings',
];

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
