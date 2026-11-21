import type { Migration } from './types.ts';

/*
 * A project can name other conversations as its background material. The user
 * picks them; the platform only concatenates them into the prompt, it never
 * decides what is relevant.
 */
export const migration020: Migration = {
  id: '020_project_background',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_background (
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (project_id, conversation_id)
      );

      CREATE INDEX IF NOT EXISTS idx_project_background_conversation
        ON project_background(conversation_id);
    `);
  },
};
