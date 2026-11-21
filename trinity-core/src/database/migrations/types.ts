import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  up: (db: DatabaseSync) => void;
}
