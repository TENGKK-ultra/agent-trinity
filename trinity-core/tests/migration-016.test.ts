import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { openDatabase } from '../src/database/connection.ts';
import { activateBinding, findSession } from '../src/harnesses/session.service.ts';
import { createTempDatabase } from './helpers.ts';

function columns(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare('PRAGMA table_info(harness_sessions)').all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test('迁移 016：全新数据库包含 participating，默认参与', () => {
  const db = openDatabase(':memory:');

  try {
    assert.ok(columns(db).includes('participating'));

    const conversation = createConversation(db, { title: '全新库' });
    activateBinding(db, conversation.id, { harnessType: 'claude', cwd: null, model: null });

    const session = findSession(db, conversation.id, 'claude');
    assert.equal(session?.participating, 1);
  } finally {
    db.close();
  }
});

test('迁移 016：从 015 升级时，已有绑定默认为参与', () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '升级' });
    activateBinding(temp.db, conversation.id, { harnessType: 'claude', cwd: null, model: null });

    // Recreate the pre-016 shape on a database that already has data: the
    // column and its index are removed and the migration record is forgotten,
    // so the next open applies migration 016 exactly as an upgrade would.
    temp.db.exec('DROP INDEX IF EXISTS idx_harness_sessions_participating');
    temp.db.exec('ALTER TABLE harness_sessions DROP COLUMN participating');
    temp.db
      .prepare("DELETE FROM schema_migrations WHERE id = '016_agent_participation'")
      .run();

    assert.ok(!columns(temp.db).includes('participating'));

    temp.close();

    const db = temp.reopen();

    assert.ok(columns(db).includes('participating'));

    const session = db
      .prepare('SELECT participating, active FROM harness_sessions WHERE conversation_id = ?')
      .get(conversation.id) as { participating: number; active: number };

    assert.equal(session.participating, 1, '已有绑定的参与状态默认为 1');
    assert.equal(session.active, 1);
  } finally {
    temp.cleanup();
  }
});
