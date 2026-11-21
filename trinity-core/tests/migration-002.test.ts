import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/database/connection.ts';
import { migrations } from '../src/database/migrations/index.ts';
import { SCHEMA_SQL } from '../src/database/schema.ts';
import { createTempDatabase } from './helpers.ts';

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function triggerNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Builds a database that looks exactly like Phase 1.1: only migration 001 applied. */
function buildPhase1Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
    '001_initial_schema',
    '2026-11-01T00:00:00.000Z',
  );

  db.prepare(
    'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('legacy-project', '遗留项目', null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');

  const insertLegacy = db.prepare(
    `INSERT INTO project_memory (id, project_id, kind, content, confirmed, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  insertLegacy.run(
    'legacy-fact',
    'legacy-project',
    'fact',
    '项目使用 Node.js 24',
    1,
    1,
    '2026-11-02T00:00:00.000Z',
  );
  insertLegacy.run(
    'legacy-draft',
    'legacy-project',
    'decision',
    '决定使用 SQLite',
    0,
    1,
    '2026-11-03T00:00:00.000Z',
  );
  insertLegacy.run(
    'legacy-unknown',
    'legacy-project',
    'something_unmapped',
    '未知类别的旧内容',
    0,
    2,
    '2026-11-04T00:00:00.000Z',
  );

  db.close();
}

test('迁移 002：全新数据库会建出记忆表、扩展快照列并安装触发器', () => {
  const temp = createTempDatabase();

  try {
    const tables = tableNames(temp.db);
    assert.ok(tables.includes('project_memories'));
    assert.ok(tables.includes('project_memory_versions'));
    assert.ok(tables.includes('project_memory'), '旧表必须保留');

    const snapshotColumns = columnNames(temp.db, 'context_snapshots');
    for (const expected of [
      'snapshot_type',
      'title',
      'content_json',
      'source_memory_ids',
      'source_conversation_ids',
      'created_by',
      'parent_snapshot_id',
      'metadata_json',
    ]) {
      assert.ok(snapshotColumns.includes(expected), `快照表缺少列 ${expected}`);
    }

    const triggers = triggerNames(temp.db);
    assert.ok(triggers.includes('trg_context_snapshots_no_update'));
    assert.ok(triggers.includes('trg_context_snapshots_no_delete'));

    const applied = (
      temp.db.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as { total: number }
    ).total;
    assert.equal(applied, migrations.length);
  } finally {
    temp.cleanup();
  }
});

test('迁移 002：模拟 Phase 1.1 旧库升级并正确映射旧记忆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-upgrade-'));
  const dbPath = join(dir, 'legacy.db');

  try {
    buildPhase1Database(dbPath);

    const db = openDatabase(dbPath);

    const memories = db
      .prepare('SELECT * FROM project_memories ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    assert.equal(memories.length, 3);

    const fact = memories.find((row) => row.id === 'legacy-fact');
    assert.ok(fact);
    assert.equal(fact.category, 'fact');
    assert.equal(fact.status, 'confirmed');
    assert.equal(fact.source_type, 'imported');
    assert.equal(fact.content, '项目使用 Node.js 24');
    assert.equal(fact.confirmed_at, null, '旧数据没有确认时间，不能编造');
    assert.equal(fact.confirmed_by, null, '旧数据没有确认人，不能编造');
    assert.equal(fact.source_conversation_id, null);
    assert.equal(fact.source_message_id, null);
    assert.equal(fact.version, 1);

    const factMeta = JSON.parse(String(fact.metadata_json)) as Record<string, unknown>;
    assert.equal(factMeta.legacy_table, 'project_memory');
    assert.equal(factMeta.legacy_kind, 'fact');
    assert.equal(factMeta.legacy_version, 1);
    assert.equal(factMeta.category_mapped, true);

    const draft = memories.find((row) => row.id === 'legacy-draft');
    assert.ok(draft);
    assert.equal(draft.category, 'decision');
    assert.equal(draft.status, 'draft');

    const unknown = memories.find((row) => row.id === 'legacy-unknown');
    assert.ok(unknown);
    assert.equal(unknown.category, 'unverified', '未知类别不得升级为 fact');
    assert.equal(unknown.status, 'draft');
    const unknownMeta = JSON.parse(String(unknown.metadata_json)) as Record<string, unknown>;
    assert.equal(unknownMeta.legacy_kind, 'something_unmapped');
    assert.equal(unknownMeta.category_mapped, false);
    assert.equal(unknownMeta.legacy_version, 2);

    const versions = db
      .prepare('SELECT * FROM project_memory_versions ORDER BY memory_id')
      .all() as Array<Record<string, unknown>>;
    assert.equal(versions.length, 3);
    for (const row of versions) {
      assert.equal(row.version, 1);
      assert.equal(row.change_reason, 'legacy-import');
    }

    const legacyRows = db
      .prepare('SELECT COUNT(*) AS total FROM project_memory')
      .get() as { total: number };
    assert.equal(legacyRows.total, 3, '旧表必须原样保留，不得删除');

    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
      id: string;
    }>;
    assert.deepEqual(applied.map((row) => row.id), [
      '001_initial_schema',
      '002_phase2_memory_and_snapshots',
      '003_d3_harness_session_status',
      '004_d3_3_multi_agent_sessions',
      '005_d3_5_1_change_log',
      '006_d3_5_2a_approvals',
      '007_d3_5_3_agent_tasks',
      '008_d3_5_3b_session_quarantine',
      '009_d3_5_3_command_debug',
      '010_d3_5_3d_agent_usage',
      '011_d3_5_3d_usage_model',
      '012_collab_message_bus',
      '013_collab_message_reason',
      '014_collab_budgets_and_orchestration',
      '015_collab_contributions',
      '016_agent_participation',
      '017_board_and_cross_review',
      '018_board_requested_agent',
      '019_workspaces',
      '020_project_background',
      '021_session_permission_mode',
      '022_conversation_title_source',
    ]);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移 002：重复打开不会重复执行，也不会重复搬迁数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-upgrade-idem-'));
  const dbPath = join(dir, 'legacy.db');

  try {
    buildPhase1Database(dbPath);

    const first = openDatabase(dbPath);
    const firstCount = (
      first.prepare('SELECT COUNT(*) AS total FROM project_memories').get() as { total: number }
    ).total;
    first.close();

    const second = openDatabase(dbPath);
    const secondCount = (
      second.prepare('SELECT COUNT(*) AS total FROM project_memories').get() as { total: number }
    ).total;
    const applied = (
      second.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as { total: number }
    ).total;

    assert.equal(firstCount, 3);
    assert.equal(secondCount, 3);
    assert.equal(applied, migrations.length);

    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移 002：没有旧数据的库也能正常升级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-upgrade-empty-'));
  const dbPath = join(dir, 'legacy-empty.db');

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(SCHEMA_SQL);
    legacy.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    legacy
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      .run('001_initial_schema', '2026-11-01T00:00:00.000Z');
    legacy.close();

    const db = openDatabase(dbPath);

    const memories = (
      db.prepare('SELECT COUNT(*) AS total FROM project_memories').get() as { total: number }
    ).total;
    const versions = (
      db.prepare('SELECT COUNT(*) AS total FROM project_memory_versions').get() as { total: number }
    ).total;

    assert.equal(memories, 0);
    assert.equal(versions, 0);
    assert.ok(triggerNames(db).includes('trg_context_snapshots_no_update'));

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
