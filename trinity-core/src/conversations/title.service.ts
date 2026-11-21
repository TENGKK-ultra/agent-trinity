import type { DatabaseSync } from 'node:sqlite';
import { safeSlice } from '../common/text.ts';
import { buildChildEnv, runProcess } from '../harnesses/runner.ts';
import type { HarnessAdapter } from '../harnesses/types.ts';
import { withTransaction } from '../database/transaction.ts';
import { appendChange, SYSTEM_ACTOR } from '../changes/change-log.service.ts';

/**
 * A conversation named after its first instruction, written by the agent that
 * ran it. The call is one-shot and independent of the turn: no message and no
 * session row is written, so the chat stays exactly what the user said.
 */
const MAX_TITLE = 20;
const TITLE_TIMEOUT_MS = 60_000;

export function sanitizeTitle(text: string): string | null {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');

  if (!first) return null;

  const cleaned = first
    .replace(/^[\s"'“”‘’《》「」【】#*]+/u, '')
    .replace(/[\s"'“”‘’《》「」【】#*]+$/u, '')
    .replace(/^标题[:：]\s*/u, '')
    .trim();

  const title = safeSlice(cleaned, MAX_TITLE).trim();

  return title === '' ? null : title;
}

export async function autoTitleAfterFirstTurn(
  db: DatabaseSync,
  conversationId: string,
  adapter: HarnessAdapter,
  session: { cwd: string | null; model: string | null },
  firstUserContent: string,
): Promise<void> {
  const row = db
    .prepare('SELECT title_source FROM conversations WHERE id = ?')
    .get(conversationId) as { title_source: string } | undefined;

  if (!row || row.title_source !== 'default') return;

  const users = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND message_type = 'user_message'",
    )
    .get(conversationId) as { n: number };

  if (users.n !== 1) return;

  const prompt = [
    '只根据下面这句用户指令，为这个对话拟一个不超过 12 个字的中文标题。',
    '只输出标题本身：不要引号、不要解释、不要句号。',
    `用户指令：${safeSlice(firstUserContent, 400)}`,
  ].join('\n');

  const command = adapter.buildCommand({
    prompt,
    cwd: session.cwd ?? process.cwd(),
    nativeSessionId: null,
    model: session.model,
  });

  let finalText = '';
  const parts: string[] = [];

  await runProcess({
    file: command.file,
    args: command.args,
    cwd: session.cwd ?? process.cwd(),
    env: buildChildEnv(command.env),
    timeoutMs: TITLE_TIMEOUT_MS,
    stdin: command.stdin,
    initialInput: command.initialInput,
    onLine: (line) => {
      const frame = adapter.parseLine(line);
      if (!frame) return;
      if (frame.terminal?.finalText) finalText = frame.terminal.finalText;
      for (const event of frame.events ?? []) {
        if (event.type === 'assistant_text') parts.push(event.text);
      }
    },
  });

  const title = sanitizeTitle(finalText || parts.join(''));
  if (!title) return;

  withTransaction(db, () => {
    // Re-check inside the write: a rename may have landed while we were waiting.
    const still = db
      .prepare('SELECT title_source FROM conversations WHERE id = ?')
      .get(conversationId) as { title_source: string } | undefined;

    if (still?.title_source !== 'default') return;

    db.prepare(
      "UPDATE conversations SET title = ?, title_source = 'auto', updated_at = ? WHERE id = ? AND title_source = 'default'",
    ).run(title, new Date().toISOString(), conversationId);

    appendChange(db, {
      entityType: 'conversation',
      entityId: conversationId,
      operation: 'update',
      actor: SYSTEM_ACTOR,
      conversationId,
      payload: { title_source: 'auto' },
    });
  });
}
