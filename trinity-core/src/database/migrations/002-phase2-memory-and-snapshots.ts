import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

const MEMORY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS project_memories (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category                TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'confirmed', 'rejected', 'superseded', 'archived')),
  title                   TEXT NOT NULL,
  content                 TEXT NOT NULL,
  source_type             TEXT NOT NULL DEFAULT 'unknown',
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  confirmed_at            TEXT,
  confirmed_by            TEXT,
  supersedes_memory_id    TEXT REFERENCES project_memories(id) ON DELETE SET NULL,
  version                 INTEGER NOT NULL DEFAULT 1,
  metadata_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_project_memories_project_status
  ON project_memories(project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_memories_project_category
  ON project_memories(project_id, category);
CREATE INDEX IF NOT EXISTS idx_project_memories_supersedes
  ON project_memories(supersedes_memory_id);

CREATE TABLE IF NOT EXISTS project_memory_versions (
  id            TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  category      TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  change_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (memory_id, version)
);

CREATE INDEX IF NOT EXISTS idx_project_memory_versions_memory
  ON project_memory_versions(memory_id, version);
`;

const SNAPSHOT_COLUMNS: Array<{ name: string; definition: string }> = [
  { name: 'snapshot_type', definition: "TEXT NOT NULL DEFAULT 'manual'" },
  { name: 'title', definition: "TEXT NOT NULL DEFAULT ''" },
  { name: 'content_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { name: 'source_memory_ids', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'source_conversation_ids', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'created_by', definition: "TEXT NOT NULL DEFAULT ''" },
  {
    name: 'parent_snapshot_id',
    definition: 'TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL',
  },
  { name: 'metadata_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
];

const SNAPSHOT_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_context_snapshots_no_update
BEFORE UPDATE ON context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'context_snapshots is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_context_snapshots_no_delete
BEFORE DELETE ON context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'context_snapshots is append-only: DELETE is not allowed');
END;
`;

const CATEGORY_MAP: Record<string, string> = {
  fact: 'fact',
  decision: 'decision',
  hypothesis: 'hypothesis',
  unverified: 'unverified',
  constraint: 'constraint',
  architecture: 'architecture',
  issue: 'issue',
  progress: 'progress',
};

interface LegacyMemoryRow {
  id: string;
  project_id: string;
  kind: string;
  content: string;
  confirmed: number;
  version: number;
  created_at: string;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;
  return columns.some((entry) => entry.name === column);
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (firstLine === '') return '(untitled legacy memory)';
  return firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;
}

function migrateLegacyMemories(db: DatabaseSync): void {
  const legacyRows = db
    .prepare(
      'SELECT id, project_id, kind, content, confirmed, version, created_at FROM project_memory',
    )
    .all() as unknown as LegacyMemoryRow[];

  if (legacyRows.length === 0) return;

  const insertMemory = db.prepare(
    `INSERT INTO project_memories
       (id, project_id, category, status, title, content, source_type,
        source_conversation_id, source_message_id, created_at, updated_at,
        confirmed_at, confirmed_by, supersedes_memory_id, version, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, 1, ?)`,
  );

  const insertVersion = db.prepare(
    `INSERT INTO project_memory_versions
       (id, memory_id, version, category, status, title, content,
        created_at, created_by, change_reason, metadata_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, 'legacy-import', ?)`,
  );

  for (const row of legacyRows) {
    const known = Object.hasOwn(CATEGORY_MAP, row.kind);
    // Unrecognised legacy categories are never promoted to fact: they land as unverified.
    const category = known ? (CATEGORY_MAP[row.kind] as string) : 'unverified';
    const status = row.confirmed === 1 ? 'confirmed' : 'draft';
    const title = deriveTitle(row.content);

    const metadata = JSON.stringify({
      legacy_table: 'project_memory',
      legacy_id: row.id,
      legacy_kind: row.kind,
      legacy_version: row.version,
      legacy_confirmed: row.confirmed === 1,
      category_mapped: known,
    });

    insertMemory.run(
      row.id,
      row.project_id,
      category,
      status,
      title,
      row.content,
      'imported',
      row.created_at,
      row.created_at,
      metadata,
    );

    insertVersion.run(
      randomUUID(),
      row.id,
      category,
      status,
      title,
      row.content,
      row.created_at,
      metadata,
    );
  }

  const migrated = (
    db.prepare('SELECT COUNT(*) AS total FROM project_memories').get() as { total: number }
  ).total;
  const versioned = (
    db.prepare('SELECT COUNT(*) AS total FROM project_memory_versions').get() as { total: number }
  ).total;

  if (migrated !== legacyRows.length || versioned !== legacyRows.length) {
    throw new Error(
      `[migration 002] legacy memory count mismatch: expected ${legacyRows.length}, ` +
        `migrated ${migrated}, versioned ${versioned}`,
    );
  }
}

export const migration002: Migration = {
  id: '002_phase2_memory_and_snapshots',
  up: (db) => {
    db.exec(MEMORY_TABLES_SQL);

    for (const column of SNAPSHOT_COLUMNS) {
      addColumnIfMissing(db, 'context_snapshots', column.name, column.definition);
    }

    db.exec(SNAPSHOT_TRIGGERS_SQL);

    migrateLegacyMemories(db);
  },
};
