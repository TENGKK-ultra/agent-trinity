import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { countCharacters, safeSlice } from '../common/text.ts';

const MAX_COMMAND_CHARS = 8_000;

export interface CommandDebugInput {
  conversationId: string;
  /** The tool_call row this command produced, kept for cross-reference only. */
  messageId: string | null;
  turnId: string;
  agent: string;
  program: string;
  command: string;
}

/**
 * Local troubleshooting evidence, deliberately kept out of `messages`: no DTO
 * reads this table, so the raw command can be retained without being served.
 * A failure here must never fail the turn that produced it.
 */
export function recordCommand(db: DatabaseSync, input: CommandDebugInput): boolean {
  const command =
    input.command.length > MAX_COMMAND_CHARS
      ? `${safeSlice(input.command, MAX_COMMAND_CHARS)}\n…（已截断：原始 ${countCharacters(input.command)} 字符）`
      : input.command;

  try {
    db.prepare(
      `INSERT INTO command_debug
         (id, conversation_id, message_id, turn_id, agent, program, command, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.conversationId,
      input.messageId,
      input.turnId,
      input.agent,
      input.program,
      command,
      new Date().toISOString(),
    );

    return true;
  } catch {
    return false;
  }
}
