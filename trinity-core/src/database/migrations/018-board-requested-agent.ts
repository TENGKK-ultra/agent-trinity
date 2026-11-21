import type { Migration } from './types.ts';

/*
 * The user's explicit assignment wins over the default dispatcher. A card may
 * name the agent that must execute it; the cross-review loop then skips the
 * Codex dispatch turn and starts that agent directly.
 */
export const migration018: Migration = {
  id: '018_board_requested_agent',
  up: (db) => {
    db.exec('ALTER TABLE board_cards ADD COLUMN requested_agent TEXT;');
  },
};
