import type { Migration } from './types.ts';

/*
 * Who last named the conversation. Auto titles must never overwrite a title the
 * user typed themselves.
 */
export const migration022: Migration = {
  id: '022_conversation_title_source',
  up: (db) => {
    db.exec(
      "ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'default';",
    );
  },
};
