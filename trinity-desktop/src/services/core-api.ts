import { request } from './api-client';

export type MessageType =
  | 'user_message'
  | 'agent_message'
  | 'agent_final'
  | 'tool_call'
  | 'tool_result'
  | 'system_event'
  | 'task_status';

export type SenderKind = 'user' | 'agent' | 'system';
export type ConversationStatus = 'active' | 'archived';

export interface ConversationDto {
  id: string;
  project_id: string | null;
  title: string;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
}

export interface MessageDto {
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

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const result = search.toString();
  return result === '' ? '' : `?${result}`;
}

export function listConversations(params: {
  limit?: number;
  offset?: number;
  sort?: 'created' | 'updated';
  order?: 'asc' | 'desc';
  status?: ConversationStatus;
}): Promise<Paged<ConversationDto>> {
  return request<Paged<ConversationDto>>(
    `/api/conversations${query({
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      order: params.order,
      status: params.status,
    })}`,
  );
}

export function createConversation(title: string): Promise<ConversationDto> {
  return request<ConversationDto>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export function getConversation(id: string): Promise<ConversationDto> {
  return request<ConversationDto>(`/api/conversations/${encodeURIComponent(id)}`);
}

export function updateConversation(
  id: string,
  patch: { title?: string; status?: ConversationStatus },
): Promise<ConversationDto> {
  return request<ConversationDto>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function listMessages(
  conversationId: string,
  params: { limit?: number; offset?: number; messageType?: MessageType } = {},
): Promise<Paged<MessageDto>> {
  return request<Paged<MessageDto>>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query({
      limit: params.limit,
      offset: params.offset,
      message_type: params.messageType,
    })}`,
  );
}

export function sendMessage(
  conversationId: string,
  content: string,
  messageType: MessageType = 'user_message',
): Promise<MessageDto> {
  return request<MessageDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ content, message_type: messageType }),
    },
  );
}

export interface AgentSessionDto {
  agent: string;
  display_name: string;
  active: boolean;
  /** Takes part in this conversation; independent of which one is current. */
  participating: boolean;
  status: 'idle' | 'running' | 'error';
  native_session_id: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode?: string | null;
  last_seen_at: string | null;
  created_at?: string;
}

export interface AgentStateDto {
  agent: string | null;
  active_agent: string | null;
  available: string[];
  bindings: AgentSessionDto[];
  warning?: string | null;
  removed?: boolean;
  was_active?: boolean;
}

export interface TurnStartedDto {
  message: MessageDto;
  turn_id: string | null;
  agent: string | null;
}

export function getAgent(conversationId: string): Promise<AgentStateDto> {
  return request<AgentStateDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent`,
  );
}

export type AgentKind = 'claude' | 'codex' | 'deepseek';

/** One row of the capability directory: state only, never a recommendation. */
export interface AgentDirectoryDto {
  agent: AgentKind;
  display_name: string;
  bound_conversations: number;
  participating_conversations: number;
  active_conversations: number;
  running_conversations: number;
  quarantined_conversations: number;
  last_seen_at: string | null;
  cwd: string | null;
  model: string | null;
}

export function listAgentDirectory(): Promise<{ items: AgentDirectoryDto[] }> {
  return request<{ items: AgentDirectoryDto[] }>('/api/agents');
}

export function bindAgent(
  conversationId: string,
  options: { agent?: AgentKind; cwd?: string; model?: string; active?: boolean } = {},
): Promise<AgentStateDto> {
  return request<AgentStateDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent`,
    {
      method: 'POST',
      body: JSON.stringify(options),
    },
  );
}

/** Joins or leaves the conversation without deleting the agent's binding. */
export function setAgentParticipating(
  conversationId: string,
  agent: AgentKind,
  participating: boolean,
): Promise<AgentStateDto> {
  return request<AgentStateDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent`,
    {
      method: 'PATCH',
      body: JSON.stringify({ agent, participating }),
    },
  );
}

export function unbindAgent(
  conversationId: string,
  agent: AgentKind,
): Promise<AgentStateDto> {
  return request<AgentStateDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent?agent=${encodeURIComponent(agent)}`,
    { method: 'DELETE' },
  );
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type ApprovalDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface ApprovalDto {
  id: string;
  conversation_id: string;
  agent: string;
  kind: 'tool_approval' | 'question';
  tool_name: string | null;
  tool_use_id: string | null;
  /** The display view only — the provider's full input stays in memory. */
  payload: {
    tool_name?: string;
    description?: string | null;
    /** Human wording for the card title, when the tool name would be opaque. */
    label?: string;
    detail?: string | null;
    input_keys?: string[];
    questions?: Array<{
      question: string;
      header: string | null;
      options: Array<{ label: string; description: string | null }>;
      multiSelect: boolean;
    }>;
  };
  status: ApprovalStatus;
  delivery_status: ApprovalDeliveryStatus;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

export function listApprovals(
  conversationId: string,
  status?: ApprovalStatus,
): Promise<{ items: ApprovalDto[] }> {
  return request<{ items: ApprovalDto[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/approvals${query({ status })}`,
  );
}

export function decideApproval(
  conversationId: string,
  approvalId: string,
  body: { agent: string; decision: 'approve' | 'deny'; answers?: Record<string, string> },
): Promise<ApprovalDto> {
  return request<ApprovalDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function sendTurn(conversationId: string, content: string): Promise<TurnStartedDto> {
  return request<TurnStartedDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    },
  );
}

export async function probeCore(): Promise<void> {
  await listConversations({ limit: 1 });
}

/* ---------- Dashboard: activity and tasks ---------- */

export interface ActivityItemDto {
  seq: number;
  message_id: string;
  conversation_id: string;
  agent: string | null;
  sender_id: string | null;
  /** Activity kinds today are tool_call / tool_result / task_status; unknown kinds must still render. */
  kind: string;
  content_preview: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityPageDto {
  items: ActivityItemDto[];
  head_seq: number;
  has_more: boolean;
  limit: number;
}

/** One activity with its full body; the list only carries a preview. */
export interface ActivityDetailDto extends ActivityItemDto {
  content: string;
}

export interface TaskDto {
  id: string;
  conversation_id: string;
  parent_task_id: string | null;
  chain_id: string;
  depth: number;
  source_agent: string | null;
  source_turn_id: string | null;
  target_agent: string;
  target_turn_id: string | null;
  title: string;
  instruction_preview: string;
  instruction_length: number;
  status: string;
  delivery_status: string;
  result_message_id: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  conversation_title?: string;
}

export interface TaskPageDto {
  items: TaskDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface TaskDetailDto {
  task: TaskDto;
  result: { message_id: string; content_preview: string; created_at: string } | null;
}

export function listActivity(
  conversationId: string,
  params: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
): Promise<ActivityPageDto> {
  return request<ActivityPageDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/activity${query({
      after_seq: params.afterSeq,
      before_seq: params.beforeSeq,
      limit: params.limit,
    })}`,
  );
}

export function getActivityItem(
  conversationId: string,
  messageId: string,
): Promise<ActivityDetailDto> {
  return request<ActivityDetailDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/activity/${encodeURIComponent(messageId)}`,
  );
}

export function listAllTasks(
  params: { status?: string; limit?: number; offset?: number } = {},
): Promise<TaskPageDto> {
  return request<TaskPageDto>(
    `/api/tasks${query({
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    })}`,
  );
}

export function getTaskDetail(
  conversationId: string,
  taskId: string,
): Promise<TaskDetailDto> {
  return request<TaskDetailDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}`,
  );
}

// ---------- Search ----------

export interface SearchConversationHitDto {
  id: string;
  title: string;
  updated_at: string;
}

export interface SearchMessageHitDto {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  sender_kind: string;
  snippet: string;
  created_at: string;
}

export interface SearchResultDto {
  query: string;
  conversations: SearchConversationHitDto[];
  messages: SearchMessageHitDto[];
}

export function searchAll(text: string, limit = 12): Promise<SearchResultDto> {
  return request<SearchResultDto>(`/api/search${query({ q: text, limit })}`);
}

// ---------- Events ----------

export type EventFilterDto = 'all' | 'task' | 'system' | 'error';

export interface EventItemDto {
  id: string;
  conversation_id: string;
  conversation_title: string | null;
  source: 'task' | 'system';
  reason: string | null;
  failed: boolean;
  content: string;
  created_at: string;
}

export interface EventPageDto {
  items: EventItemDto[];
  total: number;
  limit: number;
  offset: number;
  counts: { task: number; system: number; error: number };
}

export function listEvents(
  params: { filter?: EventFilterDto; limit?: number; offset?: number } = {},
): Promise<EventPageDto> {
  return request<EventPageDto>(
    `/api/events${query({
      filter: params.filter,
      limit: params.limit,
      offset: params.offset,
    })}`,
  );
}

// ---------- Usage ----------

export interface UsageTotalsDto {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export interface UsageEchoDto {
  from: string | null;
  to: string | null;
  agent: string | null;
  configured_model: string | null;
}

export interface UsageAgentRowDto extends UsageTotalsDto {
  agent: string;
}

export interface UsageModelRowDto extends UsageTotalsDto {
  configured_model: string | null;
}

export interface UsageSummaryDto {
  filters: UsageEchoDto;
  totals: UsageTotalsDto;
  by_agent: UsageAgentRowDto[];
  by_model: UsageModelRowDto[];
}

export interface UsageDailyRowDto extends UsageTotalsDto {
  date: string;
}

export interface UsageDailyDto {
  filters: UsageEchoDto;
  days: UsageDailyRowDto[];
}

export interface UsageItemDto extends UsageTotalsDto {
  recorded_at: string;
  agent: string;
  configured_model: string | null;
  scope: string;
  turn_id: string;
  task_id: string | null;
  anomaly: string | null;
}

export interface UsageConversationDto {
  conversation_id: string;
  filters: UsageEchoDto;
  totals: UsageTotalsDto;
  by_agent: UsageAgentRowDto[];
  items: UsageItemDto[];
  limit: number;
  offset: number;
}

export interface UsageTaskDto {
  task_id: string;
  conversation_id: string;
  filters: UsageEchoDto;
  totals: UsageTotalsDto;
  by_agent: UsageAgentRowDto[];
}

export interface UsageQuery {
  from?: string;
  to?: string;
  agent?: string;
  model?: string;
  limit?: number;
  offset?: number;
}

function usageQuery(params: UsageQuery): string {
  return query({
    from: params.from,
    to: params.to,
    agent: params.agent,
    model: params.model,
    limit: params.limit,
    offset: params.offset,
  });
}

export function getUsageSummary(params: UsageQuery = {}): Promise<UsageSummaryDto> {
  return request<UsageSummaryDto>(`/api/usage/summary${usageQuery(params)}`);
}

export function getUsageDaily(params: UsageQuery = {}): Promise<UsageDailyDto> {
  return request<UsageDailyDto>(`/api/usage/daily${usageQuery(params)}`);
}

export function getConversationUsage(
  conversationId: string,
  params: UsageQuery = {},
): Promise<UsageConversationDto> {
  return request<UsageConversationDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/usage${usageQuery(params)}`,
  );
}

export function getTaskUsage(
  conversationId: string,
  taskId: string,
  params: UsageQuery = {},
): Promise<UsageTaskDto> {
  return request<UsageTaskDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/usage${usageQuery(params)}`,
  );
}

/* ---------- Collaboration rounds ---------- */

export type CollabRoundStatus =
  | 'created'
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'blocked'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type CollabOutcome = 'completed' | 'partially_completed' | 'failed' | 'cancelled';

export interface CollabBudgetDto {
  used: number;
  limit: number;
}

export interface CollabRoundDto {
  id: string;
  conversation_id: string;
  goal: string;
  status: CollabRoundStatus;
  outcome: CollabOutcome | null;
  coordinator: string | null;
  review_required: boolean;
  min_assignments: number;
  blocked_phase: string | null;
  budgets: {
    hops: CollabBudgetDto;
    exec: CollabBudgetDto;
    usage_tokens: { limit: number | null };
  };
  blocked_reason: string | null;
  wake_condition: string | null;
  delivery_message_id: string | null;
  created_at: string;
  closed_at: string | null;
  conversation_title?: string;
}

export interface CollabRoleDto {
  round_id: string;
  agent: string;
  role: 'coordinator' | 'contributor' | 'reviewer' | 'observer';
  assigned_by: string;
  reason: string | null;
  assigned_at: string;
}

export interface CollabTaskDto {
  id: string;
  target_agent: string;
  source_agent: string | null;
  task_type: string;
  title: string;
  instruction_preview: string;
  status: string;
  error_text: string | null;
  result_message_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CollabMessageDto {
  id: string;
  kind: 'utterance' | 'notice' | 'assignment';
  from_agent: string;
  to_agent: string | null;
  content: string;
  reason: string | null;
  state: string;
  hop: number;
  task_id: string | null;
  created_at: string;
}

export interface CollabContributionDto {
  id: string;
  agent: string;
  phase: 'planning' | 'checkpoint' | 'rework';
  content: string;
  message_id: string | null;
  created_at: string;
}

export interface CollabReviewDto {
  id: string;
  producer: string;
  reviewer: string | null;
  same_provider: boolean | null;
  status: 'pass' | 'needs_changes' | 'review_unavailable';
  findings: string[];
  created_at: string;
}

export interface CollabDetailDto {
  round: CollabRoundDto;
  roles: CollabRoleDto[];
  tasks: CollabTaskDto[];
  messages: CollabMessageDto[];
  contributions: CollabContributionDto[];
  reviews: CollabReviewDto[];
  usage: { tokens: number | null; cost_usd: number | null; rows: number };
  delivery: { id: string; content: string; message_type: string; created_at: string } | null;
}

export function listCollabRounds(
  params: { limit?: number } = {},
): Promise<{ items: CollabRoundDto[] }> {
  return request<{ items: CollabRoundDto[] }>(
    `/api/collab/rounds${query({ limit: params.limit })}`,
  );
}

export function listConversationCollabRounds(
  conversationId: string,
  params: { limit?: number } = {},
): Promise<{ items: CollabRoundDto[] }> {
  return request<{ items: CollabRoundDto[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/collab/rounds${query({
      limit: params.limit,
    })}`,
  );
}

export function createCollabRound(
  conversationId: string,
  body: {
    goal: string;
    coordinator?: string;
    targets?: string[];
    review_required?: boolean;
    min_assignments?: number;
    budget_hops?: number;
    budget_exec?: number;
    budget_usage_tokens?: number;
  },
): Promise<{ round: CollabRoundDto; goal_message_id: string }> {
  return request<{ round: CollabRoundDto; goal_message_id: string }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/collab/rounds`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export function getCollabRound(
  conversationId: string,
  roundId: string,
): Promise<CollabDetailDto> {
  return request<CollabDetailDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/collab/rounds/${encodeURIComponent(roundId)}`,
  );
}

export function cancelCollabRound(
  conversationId: string,
  roundId: string,
): Promise<{ round: CollabRoundDto }> {
  return request<{ round: CollabRoundDto }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/collab/rounds/${encodeURIComponent(roundId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
}

export function resumeCollabRound(
  conversationId: string,
  roundId: string,
  options: {
    budgetUsageTokens?: number;
    budgetHops?: number;
    minAssignments?: number;
    retryPlanning?: boolean;
  },
): Promise<{ round: CollabRoundDto }> {
  return request<{ round: CollabRoundDto }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/collab/rounds/${encodeURIComponent(roundId)}/resume`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(options.budgetUsageTokens === undefined
          ? {}
          : { budget_usage_tokens: options.budgetUsageTokens }),
        ...(options.budgetHops === undefined ? {} : { budget_hops: options.budgetHops }),
        ...(options.minAssignments === undefined
          ? {}
          : { min_assignments: options.minAssignments }),
        ...(options.retryPlanning === true ? { retry_planning: true } : {}),
      }),
    },
  );
}

export interface GroupStartDto {
  group_turn_id: string;
  mode?: 'broadcast' | 'team';
  targets: string[];
  /** Present but not started: they wait for the dispatcher's assignment. */
  waiting?: string[];
}

export type GroupSendOptions = {
  targets?: AgentKind[];
  mode?: 'broadcast' | 'team';
  dispatcher?: AgentKind;
};

/**
 * A group message is routed by Core through every agent the text mentions;
 * the response only says who was queued. Replies arrive as normal messages.
 * In team mode only the dispatcher starts; the rest are reported as waiting.
 */
export function sendGroupMessage(
  conversationId: string,
  content: string,
  options: GroupSendOptions = {},
): Promise<GroupStartDto> {
  return request<GroupStartDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/group`,
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(options.targets === undefined ? {} : { targets: options.targets }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
      }),
    },
  );
}

// ---------- Whiteboard ----------

export type BoardCardStatus =
  | 'open'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export type CrossPhase =
  | 'idle'
  | 'dispatched'
  | 'cc_work'
  | 'dsh_review'
  | 'summary'
  | 'waiting_user';

export interface BoardCardDto {
  id: string;
  conversation_id: string;
  title: string;
  goal: string;
  inputs: string[];
  acceptance: string[];
  constraints_text: string | null;
  required_capabilities: string[];
  status: BoardCardStatus;
  created_by_kind: 'user' | 'agent';
  created_by: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  result_message_id: string | null;
  execution_task_id: string | null;
  requested_agent: string | null;
  cross_round_limit: number;
  cross_round_used: number;
  cross_phase: CrossPhase;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  conversation_title?: string;
}

export interface BoardFindingDto {
  id: string;
  card_id: string;
  round_no: number;
  title: string;
  detail: string | null;
  status: 'open' | 'addressed' | 'resolved' | 'wontfix';
  raised_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
  card_title?: string;
  conversation_id?: string;
  conversation_title?: string;
}

export interface BoardEventDto {
  id: string;
  kind: string;
  actor_kind: 'user' | 'agent' | 'system';
  actor: string;
  detail: unknown;
  created_at: string;
}

export interface BoardMessageDto {
  id: string;
  card_id: string | null;
  kind: string;
  from_kind: 'user' | 'agent' | 'system';
  from_agent: string | null;
  to_agent: string | null;
  content: string;
  parent_message_id: string | null;
  hop: number;
  state: string;
  created_at: string;
}

export interface BoardDetailDto {
  card: BoardCardDto;
  events: BoardEventDto[];
  messages: BoardMessageDto[];
  findings: BoardFindingDto[];
}

export interface BoardStatusDto {
  cross_round_limit: number;
  active: BoardCardDto[];
}

export interface CreateBoardCardInput {
  title: string;
  goal: string;
  inputs?: string[];
  acceptance?: string[];
  constraints_text?: string;
  required_capabilities?: string[];
  requested_agent?: AgentKind;
  cross_round_limit?: number;
}

export function listBoardCards(
  conversationId: string,
  status?: BoardCardStatus,
): Promise<{ items: BoardCardDto[] }> {
  return request<{ items: BoardCardDto[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/board${query({ status })}`,
  );
}

export function getBoardCard(
  conversationId: string,
  cardId: string,
): Promise<BoardDetailDto> {
  return request<BoardDetailDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/board/${encodeURIComponent(cardId)}`,
  );
}

export function createBoardCard(
  conversationId: string,
  input: CreateBoardCardInput,
): Promise<{ card: BoardCardDto }> {
  return request<{ card: BoardCardDto }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/board`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function closeBoardCard(
  conversationId: string,
  cardId: string,
  reason = '用户关闭',
): Promise<{ card: BoardCardDto }> {
  return request<{ card: BoardCardDto }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/board/${encodeURIComponent(cardId)}/close`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

export function startBoardCard(
  conversationId: string,
  cardId: string,
): Promise<{ card: BoardCardDto }> {
  return request<{ card: BoardCardDto }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/board/${encodeURIComponent(cardId)}/start`,
    { method: 'POST', body: '{}' },
  );
}

export function getBoardStatus(): Promise<BoardStatusDto> {
  return request<BoardStatusDto>('/api/board/status');
}

export function listOpenBoardFindings(
  limit = 100,
): Promise<{ items: BoardFindingDto[] }> {
  return request<{ items: BoardFindingDto[] }>(`/api/board/findings${query({ limit })}`);
}

export function getTeamSettings(): Promise<{ cross_round_limit: number }> {
  return request<{ cross_round_limit: number }>('/api/settings/team');
}

export function updateTeamSettings(
  crossRoundLimit: number,
): Promise<{ cross_round_limit: number }> {
  return request<{ cross_round_limit: number }>('/api/settings/team', {
    method: 'PUT',
    body: JSON.stringify({ cross_round_limit: crossRoundLimit }),
  });
}

export interface WorkspaceDto {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

export function listWorkspaces(): Promise<{ items: WorkspaceDto[]; default_root: string }> {
  return request<{ items: WorkspaceDto[]; default_root: string }>('/api/workspaces');
}

export function createWorkspace(input: { name: string; path: string }): Promise<WorkspaceDto> {
  return request<WorkspaceDto>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
  background_count?: number;
}

export interface ProjectConversationDto {
  id: string;
  title: string;
  project_id: string | null;
  status: string;
  updated_at: string;
}

export interface ProjectDetailDto {
  project: ProjectDto;
  members: ProjectConversationDto[];
  background: string[];
}

export function listProjects(): Promise<{ items: ProjectDto[] }> {
  return request<{ items: ProjectDto[] }>('/api/projects');
}

export function createProject(input: {
  name: string;
  description?: string;
}): Promise<ProjectDto> {
  return request<ProjectDto>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getProject(projectId: string): Promise<ProjectDetailDto> {
  return request<ProjectDetailDto>(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function setProjectMember(
  projectId: string,
  conversationId: string,
  member: boolean,
): Promise<ProjectDetailDto> {
  return request<ProjectDetailDto>(
    `/api/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: 'PUT',
      body: JSON.stringify({ conversation_id: conversationId, member }),
    },
  );
}

export function setProjectBackground(
  projectId: string,
  conversationId: string,
  member: boolean,
): Promise<{ background: string[] }> {
  return request<{ background: string[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/background`,
    {
      method: 'PUT',
      body: JSON.stringify({ conversation_id: conversationId, member }),
    },
  );
}

export function setConversationPermission(
  conversationId: string,
  mode: 'manual' | 'acceptEdits' | 'plan' | 'bypassPermissions' | null,
): Promise<AgentStateDto> {
  return request<AgentStateDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/permission`,
    {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    },
  );
}
