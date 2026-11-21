import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../conversations/conversation.repository.ts';
import * as messageService from '../messages/message.service.ts';
import { appError } from '../types/index.ts';
import {
  agentActor,
  SYSTEM_ACTOR,
  type ChangeActor,
} from '../changes/change-log.service.ts';
import type { Message } from '../types/index.ts';
import { buildChildEnv, runProcess, type ProcessHandle } from './runner.ts';
import { sanitizeSummary } from './activity-summary.ts';
import { recordCommand } from './command-debug.service.ts';
import { countCharacters, safeSlice } from '../common/text.ts';
import { recordUsage } from '../usage/usage.service.ts';
import { withTransaction } from '../database/transaction.ts';
import {
  advanceLastReadAt,
  buildSharedHistory,
  cursorOf,
  encodeCursor,
} from './context.service.ts';
import {
  defaultCoreBaseUrl,
  removeDelegationConfig,
  writeDelegationConfig,
  type DelegationConfig,
} from './delegation.config.ts';
import * as sessionService from './session.service.ts';
import * as approvalService from './approval.service.ts';
import * as approvalRuntime from './approval.runtime.ts';
import {
  createPendingApproval,
  resolveApprovalTimeout,
  type ApprovalTurnContext,
} from './approval.flow.ts';
import type {
  HarnessAdapter,
  HarnessCommand,
  HarnessEvent,
  HarnessTerminal,
} from './types.ts';
import { applyBoardActions, boardPromptSection } from '../board/board-actions.ts';
import { buildProjectBackground } from '../projects/background.service.ts';
import { autoTitleAfterFirstTurn } from '../conversations/title.service.ts';

export interface TurnOptions {
  adapter: HarnessAdapter;
  timeoutMs: number;
  cwd: string;
  approvalTimeoutMs?: number;
  /** Where the delegated turn's MCP server should call back to. */
  coreBaseUrl?: string;
  /** System/developer-level instructions for this turn (role rules). */
  systemAppend?: string;
  /** Read-only tools pre-approved for this turn (no permission ask). */
  allowedTools?: string[];
  /** Merged into the metadata of every message this turn writes. */
  metadata?: Record<string, unknown>;
  /**
   * Called once, after the run lock is held and before the process starts.
   * Throwing here aborts the turn; the lock is released and nothing runs.
   */
  onStarted?: (turnId: string) => void;
}

export type TurnStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface TurnOutcome {
  status: TurnStatus;
  /** The real `agent_final` row id; null whenever no result was persisted. */
  finalMessageId: string | null;
  errorText: string | null;
}

export interface TurnStartResult {
  message: Message;
  turnId: string | null;
}

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_EXCERPT = 600;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

/**
 * An output over the message length guard used to be rejected and then swallowed,
 * so the whole activity row vanished. Cutting it here keeps the event visible and
 * the turn's evidence intact; the truncation is stated, never silent.
 */
function truncateToolOutput(content: string): string {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;

  return `${safeSlice(content, MAX_TOOL_OUTPUT_CHARS)}\n…（已截断：原始输出共 ${countCharacters(content)} 字符）`;
}

interface RunState {
  textParts: string[];
  thinkingChars: number;
  nativeSessionId: string | null;
  terminal: HarnessTerminal | null;
  unknownTypes: Set<string>;
  anomalies: Set<string>;
}

function recordMessage(
  db: DatabaseSync,
  conversationId: string,
  content: string,
  messageType: 'system_event' | 'agent_final' | 'tool_call' | 'tool_result',
  senderKind: 'agent' | 'system',
  senderId: string | null,
  metadata: Record<string, unknown>,
  actor: ChangeActor,
): Message | null {
  try {
    return messageService.addMessage(
      db,
      conversationId,
      {
        content,
        message_type: messageType,
        sender_kind: senderKind,
        sender_id: senderId,
        metadata,
      },
      actor,
    );
  } catch {
    // The conversation may have been archived mid-run; persisting the outcome
    // must not crash the turn loop.
    return null;
  }
}

function applyEvent(
  db: DatabaseSync,
  conversationId: string,
  turnId: string,
  agentName: string,
  extra: Record<string, unknown>,
  state: RunState,
  event: HarnessEvent,
): void {
  switch (event.type) {
    case 'assistant_text':
      state.textParts.push(event.text);
      return;

    case 'thinking':
      state.thinkingChars += event.text.length;
      return;

    case 'tool_call': {
      const summary = event.summary === undefined ? null : sanitizeSummary(event.summary);

      const saved = recordMessage(
        db,
        conversationId,
        event.name,
        'tool_call',
        'agent',
        agentName,
        {
          turn_id: turnId,
          tool: event.name,
          input: event.input,
          ref: event.ref,
          ...(summary === null ? {} : { summary }),
          ...extra,
        },
        agentActor(agentName),
      );

      // The raw command is evidence, not activity: it goes beside the message,
      // never into it, so no message DTO can serve it.
      if (saved !== null && event.rawCommand !== undefined) {
        const stored = recordCommand(db, {
          conversationId,
          messageId: saved.id,
          turnId,
          agent: agentName,
          program: event.name,
          command: event.rawCommand,
        });

        // A failed debug write must leave a trace, but writing another row to
        // report it would risk the same failure. The warning carries ids only.
        if (!stored) {
          console.warn(
            `[trinity-core] command_debug write failed (conversation=${conversationId}, message=${saved.id}, turn=${turnId})`,
          );
        }
      }
      return;
    }

    case 'tool_result': {
      const summary = event.summary === undefined ? null : sanitizeSummary(event.summary);

      recordMessage(
        db,
        conversationId,
        truncateToolOutput(event.content),
        'tool_result',
        'agent',
        agentName,
        {
          turn_id: turnId,
          tool: event.name,
          ref: event.ref,
          ...(summary === null ? {} : { summary }),
          ...extra,
        },
        agentActor(agentName),
      );
      return;
    }

    case 'approval_request':
      // Handled by the caller: an approval needs the live process handle.
      return;

    case 'unknown':
      state.unknownTypes.add(event.rawType);
      return;
  }
}

async function runTurn(
  db: DatabaseSync,
  conversationId: string,
  session: sessionService.HarnessSessionRow,
  lockId: string,
  turnId: string,
  prompt: string,
  options: TurnOptions,
): Promise<TurnOutcome> {
  const state: RunState = {
    textParts: [],
    thinkingChars: 0,
    nativeSessionId: session.native_session_id || null,
    terminal: null,
    unknownTypes: new Set(),
    anomalies: new Set(),
  };

  const cwd = session.cwd || options.cwd;
  const startedAt = Date.now();
  let exitConfirmed = true;
  let spawnedPid: number | null = null;
  const extra = options.metadata ?? {};

  let delegation: DelegationConfig | null = null;
  // A step that arrives without its number still needs its own slot; the turn
  // id is unique, so a per-run negative counter is enough to keep them apart.
  let syntheticSteps = 0;

  // The board section is infrastructure: what cards exist and how to claim one.
  // Reading it must never keep a turn from starting.
  let boardSection: string | null = null;

  try {
    boardSection = boardPromptSection(db, conversationId, options.adapter.type);
  } catch {
    console.warn(`[trinity-core] board prompt read failed (conversation=${conversationId})`);
  }

  // Project background: conversations the user picked as context. It is copied
  // verbatim with a size budget; the platform does not choose what matters.
  let backgroundSection: string | null = null;

  try {
    backgroundSection = buildProjectBackground(db, conversationId);
  } catch {
    console.warn(`[trinity-core] project background read failed (conversation=${conversationId})`);
  }

  // Both go in the prompt, not the system channel: the Claude CLI drops
  // --append-system-prompt on a resumed session, and neither may disappear just
  // because the conversation already had a native session.
  const sections = [backgroundSection, boardSection].filter(
    (section): section is string => section !== null && section !== '',
  );
  const effectivePrompt =
    sections.length === 0 ? prompt : `${sections.join('\n\n')}\n\n${prompt}`;
  const systemAppend = options.systemAppend ?? '';

  try {
    let command: HarnessCommand;

    try {
      // Only Claude can call back over MCP today, and only when there is
      // someone to delegate to. Injecting on every turn would spawn an MCP
      // server for nothing and, via --strict-mcp-config, hide the user's own
      // MCP servers from what used to be an ordinary turn.
      const canDelegate =
        options.adapter.type === 'claude' &&
        sessionService.listBindings(db, conversationId).some((row) => row.id !== session.id);

      if (canDelegate) {
        delegation = writeDelegationConfig({
          conversationId,
          sourceTurnId: turnId,
          roundId: typeof extra.round_id === 'string' ? extra.round_id : null,
          ttlMs: options.timeoutMs,
          coreBaseUrl: options.coreBaseUrl ?? defaultCoreBaseUrl(),
        });
      }

      command = options.adapter.buildCommand({
        prompt: effectivePrompt,
        cwd,
        nativeSessionId: state.nativeSessionId,
        model: session.model,
        ...(delegation ? { mcpConfigPath: delegation.configPath } : {}),
        ...(systemAppend !== '' ? { systemAppend } : {}),
        ...(options.allowedTools && options.allowedTools.length > 0
          ? { allowedTools: options.allowedTools }
          : {}),
        ...(session.permission_mode ? { permissionMode: session.permission_mode } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const probes =
        err instanceof Error && 'probes' in err && Array.isArray((err as { probes?: unknown }).probes)
          ? ((err as { probes: string[] }).probes.join(' | '))
          : '';

      recordMessage(
        db,
        conversationId,
        `无法启动 ${options.adapter.displayName}：${detail}${probes ? `\n探测记录：${probes}` : ''}`,
        'system_event',
        'system',
        null,
        { turn_id: turnId, reason: 'launch_failed' },
        SYSTEM_ACTOR,
      );
      sessionService.setStatus(db, session.id, 'error');
      return { status: 'failed', finalMessageId: null, errorText: detail };
    }

    let processHandle: ProcessHandle | null = null;
    let approvalContext: ApprovalTurnContext | null = null;

    const result = await runProcess({
      file: command.file,
      args: command.args,
      cwd,
      env: buildChildEnv(command.env),
      timeoutMs: options.timeoutMs,
      stdin: command.stdin,
      initialInput: command.initialInput,
      onSpawn: (handle) => {
        processHandle = handle;
        spawnedPid = handle.pid;

        if (command.stdin === 'pipe') {
          approvalContext = {
            db,
            conversationId,
            harnessSessionId: session.id,
            turnId,
            adapter: options.adapter,
            handle,
            timeoutMs: options.approvalTimeoutMs ?? resolveApprovalTimeout(),
          };
        }
      },
      onLine: (line) => {
        const frame = options.adapter.parseLine(line);
        if (!frame) return;

        if (frame.sessionId) state.nativeSessionId = frame.sessionId;

        if (frame.anomalies) {
          for (const anomaly of frame.anomalies) state.anomalies.add(anomaly);
        }

        if (frame.terminal) {
          state.terminal = frame.terminal;

          // stdin exists only to answer asks; a finished turn has none left.
          if (processHandle) processHandle.endInput();
        }

        if (frame.usage) {
          const usage = frame.usage;
          const identityMissing = usage.identityMissing === true;

          try {
            recordUsage(db, {
              agent: options.adapter.type,
              conversationId,
              turnId,
              providerSessionId: state.nativeSessionId,
              taskId: typeof extra.task_id === 'string' ? extra.task_id : null,
              roundId: typeof extra.round_id === 'string' ? extra.round_id : null,
              model: session.model ?? null,
              scope: usage.scope,
              providerTurn: identityMissing ? -1 : usage.providerTurn,
              providerStep: identityMissing ? -(++syntheticSteps) : usage.providerStep,
              ...(identityMissing ? { anomaly: 'missing_step_identity' as const } : {}),
              counterScope: usage.counterScope,
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                reasoningOutputTokens: usage.reasoningOutputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                totalTokens: usage.totalTokens,
                costUsd: usage.costUsd,
                cacheInInput: usage.cacheInInput,
              },
            });
          } catch {
            // Losing one usage row must never fail the turn it describes.
            console.warn(`[trinity-core] usage write failed (turn=${turnId})`);
          }
        }

        if (frame.events) {
          for (const event of frame.events) {
            if (event.type === 'approval_request') {
              if (approvalContext) createPendingApproval(approvalContext, event.approval);
              continue;
            }

            applyEvent(
              db,
              conversationId,
              turnId,
              options.adapter.displayName,
              options.metadata ?? {},
              state,
              event,
            );
          }
        }
      },
    });

    exitConfirmed = result.exitConfirmed;

    const terminal = state.terminal;
    let failure: string | null = null;

    if (result.spawnError) {
      failure = `无法启动进程：${result.spawnError}`;
    } else if (result.timedOut) {
      failure = `执行超时（${Math.round(options.timeoutMs / 1000)} 秒）`;
    } else if (terminal?.isError) {
      failure = terminal.errorMessage ?? 'Agent 报告执行失败';
    } else if (!terminal && result.exitCode !== 0) {
      const excerpt = result.stderr.trim().slice(0, MAX_STDERR_EXCERPT);
      failure = `进程退出码 ${String(result.exitCode)}${excerpt ? `：${excerpt}` : ''}`;
    }

    if (failure) {
      recordMessage(
        db,
        conversationId,
        failure,
        'system_event',
        'system',
        null,
        {
          turn_id: turnId,
          reason: result.timedOut ? 'timeout' : 'run_failed',
          exit_code: result.exitCode,
          ...extra,
        },
        SYSTEM_ACTOR,
      );
    }

    if (!result.exitConfirmed) {
      recordMessage(
        db,
        conversationId,
        '进程未能确认退出，该会话已被隔离，需要人工确认后才能再次使用。',
        'system_event',
        'system',
        null,
        { turn_id: turnId, reason: 'process_exit_unconfirmed', pid: spawnedPid, ...extra },
        SYSTEM_ACTOR,
      );
    }

    const finalText = terminal?.finalText?.trim() || state.textParts.join('\n\n').trim();
    let finalMessageId: string | null = null;

    if (!failure && finalText) {
      const recorded = recordMessage(
        db,
        conversationId,
        finalText,
        'agent_final',
        'agent',
        options.adapter.displayName,
        {
          turn_id: turnId,
          native_session_id: state.nativeSessionId,
          duration_ms: Date.now() - startedAt,
          thinking_chars: state.thinkingChars,
          unknown_event_types: [...state.unknownTypes],
          ...(state.anomalies.size > 0
            ? { schema_anomalies: [...state.anomalies].slice(0, 10) }
            : {}),
          ...extra,
        },
        agentActor(options.adapter.type),
      );

      finalMessageId = recorded?.id ?? null;

      if (finalMessageId !== null) {
        try {
          applyBoardActions(db, conversationId, options.adapter.type, finalText, finalMessageId);
        } catch {
          console.warn(`[trinity-core] board action apply failed (turn=${turnId})`);
        }
      }
    }

    if (state.nativeSessionId) {
      sessionService.setNativeSessionId(db, session.id, state.nativeSessionId);
    }

    const broken = failure !== null || !result.exitConfirmed;
    sessionService.setStatus(db, session.id, broken ? 'error' : 'idle');

    const status: TurnStatus = result.timedOut
      ? 'timeout'
      : result.aborted
        ? 'cancelled'
        : failure
          ? 'failed'
          : 'completed';

    return {
      status,
      finalMessageId,
      // Timeouts carry a stable code: the human wording lives in the system event.
      errorText: !result.exitConfirmed
        ? 'process_exit_unconfirmed'
        : result.timedOut
          ? 'timeout'
          : failure,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    try {
      recordMessage(
        db,
        conversationId,
        `执行异常：${detail}`,
        'system_event',
        'system',
        null,
        { turn_id: turnId, reason: 'internal_error', ...extra },
        SYSTEM_ACTOR,
      );
      sessionService.setStatus(db, session.id, 'error');
    } catch {
      // Reporting the failure must not turn it into a thrown one.
    }

    return { status: 'failed', finalMessageId: null, errorText: detail };
  } finally {
    try {
      // Nothing can answer these once the process is gone; dropping them keeps
      // a stale card from outliving its turn.
      approvalRuntime.clearTurn(turnId);
      approvalService.cancelPendingForTurn(db, turnId, 'turn_finished');
    } catch {
      // Cleanup must never keep the run lock held.
    }

    if (delegation) removeDelegationConfig(delegation);

    settleSessionAfterRun(db, session.id, lockId, { exitConfirmed, pid: spawnedPid });
  }
}

/**
 * A run whose process could not be confirmed dead leaves the session locked and
 * quarantined: a second run must never share that session with it, and lock
 * expiry alone must not reopen it.
 */
export function settleSessionAfterRun(
  db: DatabaseSync,
  sessionId: string,
  lockId: string,
  result: { exitConfirmed: boolean; pid: number | null },
): void {
  if (!result.exitConfirmed) {
    sessionService.quarantineSession(db, sessionId, 'process_exit_unconfirmed', result.pid);
    return;
  }

  sessionService.releaseRunLock(db, lockId);
}

/**
 * Sends a user message and, when the conversation has a bound agent session,
 * starts one run. The run continues in the background; the HTTP caller gets the
 * persisted user message and a turn id.
 */
export function sendTurn(
  db: DatabaseSync,
  conversationId: string,
  content: string,
  options: TurnOptions,
): TurnStartResult {
  const conversation = conversationRepository.findConversation(db, conversationId);

  if (!conversation) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  if (conversation.status === 'archived') {
    throw appError('conversation_archived', 'Conversation is archived', 409);
  }

  // Only the active harness answers; the others keep their sessions untouched.
  const session = sessionService.findActiveSession(db, conversationId);

  if (!session || session.harness_type !== options.adapter.type) {
    const message = messageService.addMessage(db, conversationId, {
      content,
      message_type: 'user_message',
      sender_kind: 'user',
    });

    return { message, turnId: null };
  }

  // No workspace, no run. Falling back to Core's own directory would let an
  // agent edit the engine; the sidebar asks the user where it should work.
  if (!session.cwd || session.cwd.trim() === '') {
    throw appError(
      'workspace_missing',
      'This agent has no workspace yet; choose one in the sidebar before sending',
      409,
    );
  }

  const holder: { message: Message | null } = { message: null };

  // The message is written from `onStarted`, i.e. after the lock is held: a
  // rejected turn must not leave a user message that no agent will answer.
  // The prompt is built after that write and reads the shared history up to it.
  const { turnId, completion } = startTurn(
    db,
    conversationId,
    session,
    () => {
      if (holder.message === null) {
        throw new Error('sendTurn: the user message was not persisted');
      }

      const before = cursorOf(holder.message);
      const history = buildSharedHistory(db, conversationId, options.adapter.type, before);

      return history === '' ? content : `${history}\n\n${content}`;
    },
    {
      ...options,
      onStarted: (startedTurnId) => {
        options.onStarted?.(startedTurnId);

        holder.message = messageService.addMessage(db, conversationId, {
          content,
          message_type: 'user_message',
          sender_kind: 'user',
        });
      },
    },
  );

  if (holder.message === null) {
    throw new Error('sendTurn: the user message was not persisted');
  }

  // The cursor moves forward only after the turn completed: a failed start or a
  // failed run re-includes the same history next time instead of losing it.
  // The position is the user message itself, fixed now — messages written while
  // the turn runs are newer and stay unread.
  const cursor = encodeCursor(cursorOf(holder.message));

  void completion
    .then((outcome) => {
      if (outcome.status !== 'completed') return;

      try {
        advanceLastReadAt(db, session.id, cursor);
      } catch {
        console.warn(`[trinity-core] shared-history cursor write failed (session=${session.id})`);
      }

      // Name the conversation after its first instruction, unless the user
      // already named it. One-shot and invisible in the transcript. Tests turn
      // it off: a background child process would hold the fixture's temp dir.
      if (process.env.TRINITY_DISABLE_AUTO_TITLE !== '1') {
        void autoTitleAfterFirstTurn(db, conversationId, options.adapter, session, content).catch(
          () => {
            console.warn(`[trinity-core] auto title failed (conversation=${conversationId})`);
          },
        );
      }
    })
    .catch(() => {});

  // The caller does not wait for the answer; the run continues in the background.
  void completion.catch(() => {});

  return { message: holder.message, turnId };
}

/**
 * The awaitable execution entry point. The lock is taken before anything else,
 * so a rejected start leaves no state behind; `completion` settles on every
 * path (finished, failed, timed out, or unconfirmed exit).
 */
export function startTurn(
  db: DatabaseSync,
  conversationId: string,
  session: sessionService.HarnessSessionRow,
  prompt: string | (() => string),
  options: TurnOptions,
): { turnId: string; completion: Promise<TurnOutcome> } {
  const turnId = randomUUID();
  const lock = sessionService.acquireRunLock(db, session.id, turnId);
  let resolved: string;

  // The prompt may depend on the message written in onStarted (the shared
  // history is read up to that message). Both happen in one transaction: if the
  // prompt cannot be built, the message rolls back and the lock is released, so
  // no cursor or half-written input survives a failed start.
  try {
    resolved = withTransaction(db, () => {
      options.onStarted?.(turnId);
      return typeof prompt === 'function' ? prompt() : prompt;
    });
  } catch (err) {
    sessionService.releaseRunLock(db, lock.id);
    throw err;
  }

  sessionService.setStatus(db, session.id, 'running');

  return {
    turnId,
    completion: runTurn(db, conversationId, session, lock.id, turnId, resolved, options),
  };
}
