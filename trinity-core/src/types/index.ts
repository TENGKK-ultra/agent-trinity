export const MESSAGE_TYPES = [
  'user_message',
  'agent_message',
  'agent_final',
  'tool_call',
  'tool_result',
  'system_event',
  'task_status',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * Internal activity is the agent's working trace, not conversation content.
 * One agent turn can emit a hundred of these, so the chat view must not show
 * them by default.
 */
export const ACTIVITY_MESSAGE_TYPES = ['tool_call', 'tool_result', 'task_status'] as const;

export function isActivityMessageType(value: string): boolean {
  return (ACTIVITY_MESSAGE_TYPES as readonly string[]).includes(value);
}

export const SENDER_KINDS = ['user', 'agent', 'system'] as const;

export type SenderKind = (typeof SENDER_KINDS)[number];

export const CONVERSATION_STATUSES = ['active', 'archived'] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  project_id: string | null;
  title: string;
  /** default | auto | user — an auto title never overwrites a user's. */
  title_source: string;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_kind: SenderKind;
  sender_id: string | null;
  message_type: MessageType;
  content: string;
  metadata_json: string | null;
  parent_message_id: string | null;
  created_at: string;
}

export interface AgentParticipant {
  id: string;
  conversation_id: string;
  agent_name: string;
  state: 'active' | 'paused';
  joined_at: string;
  updated_at: string;
}

export interface HarnessSession {
  id: string;
  harness_type: string;
  native_session_id: string;
  project_id: string | null;
  conversation_id: string | null;
  source: string | null;
  last_read_at: string | null;
  last_summary_version: number | null;
  created_at: string;
  updated_at: string;
  status: string;
  last_seen_at: string | null;
  cwd: string | null;
  model: string | null;
}

export interface HarnessSessionLock {
  id: string;
  harness_session_id: string;
  owner_task_id: string;
  acquired_at: string;
  expires_at: string | null;
  status: 'held' | 'released' | 'expired';
}

export interface ProjectMemoryEntry {
  id: string;
  project_id: string;
  kind: string;
  content: string;
  confirmed: number;
  version: number;
  created_at: string;
}

export interface ContextSnapshot {
  id: string;
  project_id: string;
  version: number;
  content: string;
  created_at: string;
}

export interface AppError extends Error {
  code: string;
  status: number;
  isAppError: true;
}

export function appError(code: string, message: string, status = 400): AppError {
  const err = new Error(message) as AppError;
  err.code = code;
  err.status = status;
  err.isAppError = true;
  return err;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isAppError?: unknown }).isAppError === true
  );
}
