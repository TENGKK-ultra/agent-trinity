import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appendChange, USER_ACTOR, type ChangeActor } from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import { appError } from '../types/index.ts';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary extends ProjectRow {
  conversation_count: number;
  background_count: number;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 2000;

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const text = value.trim();

  if (text === '') throw appError(`invalid_${field}`, `${field} must not be empty`, 400);
  if (text.length > max) throw appError(`invalid_${field}`, `${field} is too long`, 400);

  return text;
}

function requireConversation(db: DatabaseSync, id: string): void {
  const row = db.prepare('SELECT 1 AS ok FROM conversations WHERE id = ?').get(id);

  if (!row) throw appError('conversation_not_found', 'Conversation not found', 404);
}

export function findProject(db: DatabaseSync, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function requireProject(db: DatabaseSync, id: string): ProjectRow {
  const project = findProject(db, id);

  if (!project) throw appError('project_not_found', 'Project not found', 404);

  return project;
}

export function listProjects(db: DatabaseSync): ProjectSummary[] {
  return db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversation_count,
              (SELECT COUNT(*) FROM project_background b WHERE b.project_id = p.id) AS background_count
         FROM projects p
        ORDER BY p.updated_at DESC, p.created_at DESC`,
    )
    .all() as unknown as ProjectSummary[];
}

export function createProject(
  db: DatabaseSync,
  input: { name: unknown; description?: unknown },
  actor: ChangeActor = USER_ACTOR,
): ProjectRow {
  const name = requireText(input.name, 'name', MAX_NAME);
  const description =
    input.description === undefined || input.description === null
      ? null
      : requireText(input.description, 'description', MAX_DESCRIPTION);

  return withTransaction(db, () => {
    const now = new Date().toISOString();
    const row: ProjectRow = {
      id: randomUUID(),
      name,
      description,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.description, row.created_at, row.updated_at);

    appendChange(db, {
      entityType: 'project',
      entityId: row.id,
      operation: 'insert',
      actor,
      conversationId: null,
      payload: { name },
    });

    return row;
  });
}

/** A conversation belongs to at most one project; null detaches it. */
export function setConversationProject(
  db: DatabaseSync,
  conversationId: string,
  projectId: string | null,
  actor: ChangeActor = USER_ACTOR,
): void {
  requireConversation(db, conversationId);
  if (projectId !== null) requireProject(db, projectId);

  withTransaction(db, () => {
    db.prepare('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?').run(
      projectId,
      new Date().toISOString(),
      conversationId,
    );

    appendChange(db, {
      entityType: 'conversation',
      entityId: conversationId,
      operation: 'update',
      actor,
      conversationId,
      payload: { project_id: projectId },
    });
  });
}

export function listProjectMembers(db: DatabaseSync, projectId: string): Array<{
  id: string;
  title: string;
  project_id: string | null;
  status: string;
  updated_at: string;
}> {
  return db
    .prepare(
      `SELECT id, title, project_id, status, updated_at
         FROM conversations
        WHERE project_id = ?
        ORDER BY updated_at DESC`,
    )
    .all(projectId) as unknown as Array<{
    id: string;
    title: string;
    project_id: string | null;
    status: string;
    updated_at: string;
  }>;
}

export function listBackgroundIds(db: DatabaseSync, projectId: string): string[] {
  return (
    db
      .prepare(
        'SELECT conversation_id FROM project_background WHERE project_id = ? ORDER BY created_at, rowid',
      )
      .all(projectId) as Array<{ conversation_id: string }>
  ).map((row) => row.conversation_id);
}

export function setBackground(
  db: DatabaseSync,
  projectId: string,
  conversationId: string,
  member: boolean,
  actor: ChangeActor = USER_ACTOR,
): void {
  requireProject(db, projectId);
  requireConversation(db, conversationId);

  withTransaction(db, () => {
    if (member) {
      db.prepare(
        `INSERT INTO project_background (project_id, conversation_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (project_id, conversation_id) DO NOTHING`,
      ).run(projectId, conversationId, new Date().toISOString());
    } else {
      db.prepare(
        'DELETE FROM project_background WHERE project_id = ? AND conversation_id = ?',
      ).run(projectId, conversationId);
    }

    appendChange(db, {
      entityType: 'project',
      entityId: projectId,
      operation: 'update',
      actor,
      conversationId: null,
      payload: { background_conversation_id: conversationId, member },
    });
  });
}
