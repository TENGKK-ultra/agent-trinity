import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appendChange, SYSTEM_ACTOR, type ChangeActor } from '../changes/change-log.service.ts';
import { withTransaction } from '../database/transaction.ts';
import { appError } from '../types/index.ts';

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

const MAX_NAME = 80;
const MAX_PATH = 512;
const CORE_DIR = resolve(import.meta.dirname, '..', '..');

/** Where a new workspace is suggested, next to the engine but outside it. */
export const WORKSPACES_ROOT = resolve(CORE_DIR, '..', 'workspaces');

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const text = value.trim();

  if (text === '') throw appError(`invalid_${field}`, `${field} must not be empty`, 400);
  if (text.length > max) throw appError(`invalid_${field}`, `${field} is too long`, 400);

  return text;
}

export function listWorkspaces(db: DatabaseSync): WorkspaceRow[] {
  return db
    .prepare('SELECT * FROM workspaces ORDER BY name COLLATE NOCASE, created_at')
    .all() as unknown as WorkspaceRow[];
}

export function findWorkspace(db: DatabaseSync, id: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
}

/**
 * Creates the directory if it is not there yet: a workspace is a folder the
 * user names, not a registry entry that has to exist elsewhere first.
 *
 * The engine's own directory is refused: the point of a workspace is that an
 * agent works somewhere that is not Trinity's source tree.
 */
export function createWorkspace(
  db: DatabaseSync,
  input: { name: unknown; path: unknown },
  actor: ChangeActor = SYSTEM_ACTOR,
): WorkspaceRow {
  const name = requireText(input.name, 'name', MAX_NAME);
  const rawPath = requireText(input.path, 'path', MAX_PATH);

  if (!isAbsolute(rawPath)) {
    throw appError('invalid_path', 'path must be an absolute path', 400);
  }

  const path = resolve(rawPath);

  if (path === CORE_DIR || path.startsWith(`${CORE_DIR}${sep}`)) {
    throw appError(
      'workspace_forbidden',
      'A workspace must not be inside the Trinity engine directory',
      400,
    );
  }

  try {
    mkdirSync(path, { recursive: true });
  } catch {
    throw appError('invalid_workspace_path', 'The directory could not be created', 400);
  }

  return withTransaction(db, () => {
    const existing = db.prepare('SELECT id FROM workspaces WHERE path = ?').get(path) as
      | { id: string }
      | undefined;

    if (existing) {
      throw appError('workspace_exists', 'This directory is already a workspace', 409);
    }

    const now = new Date().toISOString();
    const row: WorkspaceRow = {
      id: randomUUID(),
      name,
      path,
      created_at: now,
      updated_at: now,
    };

    db.prepare(
      'INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(row.id, row.name, row.path, row.created_at, row.updated_at);

    appendChange(db, {
      entityType: 'workspace',
      entityId: row.id,
      operation: 'insert',
      actor,
      conversationId: null,
      payload: { name, path },
    });

    return row;
  });
}
