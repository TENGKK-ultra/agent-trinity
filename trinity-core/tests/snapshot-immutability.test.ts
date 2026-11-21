import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/database/connection.ts';
import { migrations } from '../src/database/migrations/index.ts';
import { createTempDatabase } from './helpers.ts';
import type { DatabaseSync } from 'node:sqlite';

function insertProject(db: DatabaseSync, id: string): void {
  db.prepare(
    'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `项目 ${id}`, null, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z');
}

function insertSnapshot(
  db: DatabaseSync,
  id: string,
  projectId: string,
  version: number,
  extra: { content?: string; parent?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO context_snapshots
       (id, project_id, version, content, created_at, content_json, title, snapshot_type,
        created_by, source_memory_ids, source_conversation_ids, parent_snapshot_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    version,
    extra.content ?? '',
    '2026-11-18T00:00:00.000Z',
    JSON.stringify({ overview: '快照内容' }),
    `快照 v${version}`,
    'project',
    'tester',
    '[]',
    '[]',
    extra.parent ?? null,
    '{}',
  );
}

test('快照：旧 content 列无默认值，因此必须显式提供占位值', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');

    assert.throws(
      () => {
        temp.db
          .prepare(
            'INSERT INTO context_snapshots (id, project_id, version, created_at) VALUES (?, ?, ?, ?)',
          )
          .run('no-content', 'p1', 1, '2026-11-18T00:00:00.000Z');
      },
      /NOT NULL/i,
      '省略 content 应因 NOT NULL 失败',
    );

    insertSnapshot(temp.db, 's1', 'p1', 1, { content: '' });

    const row = temp.db
      .prepare('SELECT content, content_json, title, snapshot_type FROM context_snapshots WHERE id = ?')
      .get('s1') as Record<string, unknown>;

    assert.equal(row.content, '');
    assert.equal(row.content_json, JSON.stringify({ overview: '快照内容' }));
    assert.equal(row.title, '快照 v1');
    assert.equal(row.snapshot_type, 'project');
  } finally {
    temp.cleanup();
  }
});

test('快照：UPDATE 被数据库触发器拒绝', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');
    insertSnapshot(temp.db, 's1', 'p1', 1);

    assert.throws(
      () => temp.db.prepare('UPDATE context_snapshots SET title = ? WHERE id = ?').run('改标题', 's1'),
      /append-only/i,
    );

    const row = temp.db
      .prepare('SELECT title FROM context_snapshots WHERE id = ?')
      .get('s1') as { title: string };
    assert.equal(row.title, '快照 v1', '内容必须保持不变');
  } finally {
    temp.cleanup();
  }
});

test('快照：DELETE 被数据库触发器拒绝', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');
    insertSnapshot(temp.db, 's1', 'p1', 1);

    assert.throws(
      () => temp.db.prepare('DELETE FROM context_snapshots WHERE id = ?').run('s1'),
      /append-only/i,
    );

    const count = (
      temp.db.prepare('SELECT COUNT(*) AS total FROM context_snapshots').get() as { total: number }
    ).total;
    assert.equal(count, 1);
  } finally {
    temp.cleanup();
  }
});

test('快照：新版本只能用 INSERT 追加，旧版本保持原样', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');
    insertSnapshot(temp.db, 's1', 'p1', 1, { content: 'v1' });
    insertSnapshot(temp.db, 's2', 'p1', 2, { content: 'v2', parent: 's1' });

    const rows = temp.db
      .prepare('SELECT id, version, content, parent_snapshot_id FROM context_snapshots ORDER BY version')
      .all() as Array<Record<string, unknown>>;

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.version, 1);
    assert.equal(rows[0]?.content, 'v1');
    assert.equal(rows[1]?.version, 2);
    assert.equal(rows[1]?.parent_snapshot_id, 's1');

    assert.throws(
      () => {
        temp.db
          .prepare(
            `INSERT INTO context_snapshots (id, project_id, version, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('dup', 'p1', 1, '', '2026-11-18T00:00:00.000Z');
      },
      /UNIQUE/i,
      '同一项目不允许重复版本号',
    );
  } finally {
    temp.cleanup();
  }
});

test('快照：重启数据库后数据仍在且触发器继续生效', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');
    insertSnapshot(temp.db, 's1', 'p1', 1, { content: '持久化' });

    temp.close();
    const reopened = temp.reopen();

    const row = reopened
      .prepare('SELECT content FROM context_snapshots WHERE id = ?')
      .get('s1') as { content: string };
    assert.equal(row.content, '持久化');

    assert.throws(
      () => reopened.prepare('DELETE FROM context_snapshots WHERE id = ?').run('s1'),
      /append-only/i,
    );
  } finally {
    temp.cleanup();
  }
});

test('快照：不同项目的版本号互不影响', () => {
  const temp = createTempDatabase();

  try {
    insertProject(temp.db, 'p1');
    insertProject(temp.db, 'p2');

    insertSnapshot(temp.db, 'a1', 'p1', 1);
    insertSnapshot(temp.db, 'b1', 'p2', 1);

    const count = (
      temp.db.prepare('SELECT COUNT(*) AS total FROM context_snapshots').get() as { total: number }
    ).total;
    assert.equal(count, 2);
  } finally {
    temp.cleanup();
  }
});

test('快照：重新打开连接后触发器定义仍存在', () => {
  const temp = createTempDatabase();

  try {
    temp.close();
    const reopened: DatabaseSync = temp.reopen();
    const triggers = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as Array<{ name: string }>;

    assert.ok(triggers.some((row) => row.name === 'trg_context_snapshots_no_update'));
    assert.ok(triggers.some((row) => row.name === 'trg_context_snapshots_no_delete'));
  } finally {
    temp.cleanup();
  }
});

test('快照：openDatabase 重复调用保持幂等', () => {
  const temp = createTempDatabase();

  try {
    temp.close();
    const again = openDatabase(temp.path);
    const applied = (
      again.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get() as { total: number }
    ).total;
    assert.equal(applied, migrations.length);
    again.close();
  } finally {
    temp.cleanup();
  }
});
