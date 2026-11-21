export const HARNESS_TYPES = ['claude', 'codex', 'deepseek'] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];

export const HARNESS_SESSION_STATUSES = ['idle', 'running', 'error'] as const;
export type HarnessSessionStatus = (typeof HARNESS_SESSION_STATUSES)[number];

/**
 * Neutral event model. Adapters translate their provider's wire format into
 * these; nothing downstream may depend on a provider-specific event shape.
 */
export type HarnessApprovalKind = 'tool_approval' | 'question';

/**
 * A provider asked for a decision. `requestId` is the provider's own id and the
 * only thing its reply may quote; `toolUseId` links the ask to the tool call
 * already streamed, so the UI can attach it to that call.
 */
export interface HarnessApprovalRequest {
  requestId: string;
  kind: HarnessApprovalKind;
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  description: string | null;
}

export type HarnessApprovalDecision =
  | { behavior: 'allow'; input: unknown }
  | { behavior: 'deny'; message: string };

export type HarnessEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_call';
      name: string;
      input: unknown;
      ref: string | null;
      summary?: string;
      /**
       * Troubleshooting evidence for the local `command_debug` table. It is
       * never written to a message and never reaches an API or DTO.
       */
      rawCommand?: string;
    }
  | {
      type: 'tool_result';
      name: string | null;
      content: string;
      ref: string | null;
      summary?: string;
    }
  | { type: 'approval_request'; approval: HarnessApprovalRequest }
  | { type: 'unknown'; rawType: string };

export interface HarnessTurnInput {
  prompt: string;
  cwd: string;
  nativeSessionId: string | null;
  model: string | null;
  /** Per-turn MCP configuration file, when this turn may delegate. */
  mcpConfigPath?: string;
  /**
   * A system/developer-level instruction for this turn. Claude receives it via
   * --append-system-prompt, Codex via developer_instructions. It sits above the
   * user prompt, which is the only place a role rule can actually bind.
   */
  systemAppend?: string;
  /** Tools that need no permission ask for this turn (read-only analysis). */
  allowedTools?: string[];
  /** Per-conversation approval mode; only Claude exposes it today. */
  permissionMode?: string;
}

export interface HarnessCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  /**
   * How the child's stdin is wired. `ignore` is the default so an adapter that
   * does not speak a stdin protocol keeps today's behaviour; only an adapter
   * that answers its provider over stdio opts into `pipe`.
   */
  stdin?: 'ignore' | 'pipe';
  /** Lines written to stdin right after spawn, one JSON message per entry. */
  initialInput?: string[];
}

export interface HarnessTerminal {
  nativeSessionId: string | null;
  finalText: string;
  isError: boolean;
  errorMessage: string | null;
}

/**
 * Usage as the provider reported it, plus the two facts the ledger needs to
 * interpret it: whether cached tokens sit inside the input, and whether the
 * numbers are a per-turn figure or a running thread total.
 */
export interface HarnessUsage {
  scope: 'turn' | 'step';
  counterScope: 'turn' | 'thread';
  cacheInInput: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens?: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  /** Step identity, when the provider reports per step. */
  providerTurn?: number;
  providerStep?: number;
  /** The provider reported a step without a usable turn/step number. */
  identityMissing?: boolean;
}

export interface HarnessStreamFrame {
  events?: HarnessEvent[];
  terminal?: HarnessTerminal;
  sessionId?: string;
  usage?: HarnessUsage;
  /** Structural problems in the provider's own output, safe to persist as text. */
  anomalies?: string[];
}

export interface ResolvedExecutable {
  file: string;
  source: string;
  /** Non-fatal problems worth surfacing, e.g. a partial install. */
  warnings?: string[];
}

export interface HarnessAdapter {
  readonly type: HarnessType;
  readonly displayName: string;
  /** Throws HarnessLocateError when no usable executable can be found. */
  resolveExecutable(): ResolvedExecutable;
  buildCommand(input: HarnessTurnInput): HarnessCommand;
  /** Returns null for lines that carry no structured information. */
  parseLine(line: string): HarnessStreamFrame | null;
  /** Serializes one decision into the line the provider expects on stdin. */
  formatApprovalDecision?(
    request: HarnessApprovalRequest,
    decision: HarnessApprovalDecision,
  ): string;
}

export class HarnessLocateError extends Error {
  readonly probes: string[];

  constructor(message: string, probes: string[]) {
    super(message);
    this.name = 'HarnessLocateError';
    this.probes = probes;
  }
}
