import type { DatabaseSync } from 'node:sqlite';
import { agentActor } from '../changes/change-log.service.ts';
import { safeSlice } from '../common/text.ts';
import type { HarnessType } from '../harnesses/types.ts';
import * as messageService from '../messages/message.service.ts';
import {
  boardAgent,
  boardSystem,
  claimCard,
  completeCard,
  createCard,
  failCard,
  findCard,
  listCards,
  postMessage,
  releaseCard,
  renewCard,
  type CardRow,
  type MessageKind,
} from './board.service.ts';

/**
 * The board protocol (step A, extended). An agent states its intent on single
 * lines of its own final text; the platform parses them after the turn and
 * applies them through the same atomic lease functions. No MCP dependency, and
 * the platform never decides who should work — it records what the agent said.
 */
export const BOARD_ACTION_MARKER = '[[board]]';

const MAX_ACTIONS_PER_TURN = 5;
const MAX_PROMPT_CARDS = 5;
const MAX_PROMPT_CLAIMED = 3;
const GOAL_EXCERPT = 160;
const MAX_ERROR_CHARS = 300;
const MAX_RESULT_CHARS = 4_000;
const MAX_REASON_CHARS = 2_000;
const MAX_POST_CHARS = 4_000;

const POST_KINDS = ['utterance', 'question', 'result', 'review'] as const;
type PostKind = (typeof POST_KINDS)[number];

const AGENT_DISPLAY: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
};

export type BoardAction =
  | { action: 'claim'; cardId: string }
  | { action: 'pass' }
  | { action: 'renew'; cardId: string }
  | { action: 'release'; cardId: string }
  | { action: 'complete'; cardId: string; result: string }
  | { action: 'fail'; cardId: string; reason: string }
  | { action: 'post'; cardId: string; content: string; kind: PostKind }
  | { action: 'create'; title: string; goal: string; acceptance: string[] };

export interface ParsedBoardActions {
  actions: BoardAction[];
  errors: string[];
}

function cardIdOf(record: Record<string, unknown>, name: string, errors: string[]): string | null {
  const value = record.card_id;

  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${name} 缺少 card_id`);

    return null;
  }

  return value.trim();
}

function textOf(
  record: Record<string, unknown>,
  field: string,
  max: number,
  name: string,
  errors: string[],
): string | null {
  const value = record[field];

  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${name} 缺少 ${field}`);

    return null;
  }

  const text = value.trim();

  if (text.length > max) {
    errors.push(`${name} 的 ${field} 超过 ${max} 字`);

    return null;
  }

  return text;
}

export function parseBoardActions(text: string): ParsedBoardActions {
  const actions: BoardAction[] = [];
  const errors: string[] = [];
  const claimed = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line.startsWith(BOARD_ACTION_MARKER)) continue;

    if (actions.length >= MAX_ACTIONS_PER_TURN) {
      errors.push(`一次回复最多 ${MAX_ACTIONS_PER_TURN} 个白板动作，多余的已忽略`);
      break;
    }

    const payload = line.slice(BOARD_ACTION_MARKER.length).trim();
    let value: unknown;

    try {
      value = JSON.parse(payload);
    } catch {
      errors.push(`不是合法 JSON：${safeSlice(payload, 80)}`);
      continue;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push('动作必须是 JSON 对象');
      continue;
    }

    const record = value as Record<string, unknown>;
    const name = record.action;

    if (name === 'pass') {
      actions.push({ action: 'pass' });
      continue;
    }

    if (name === 'create') {
      const title = textOf(record, 'title', 200, 'create', errors);
      const goal = textOf(record, 'goal', 4_000, 'create', errors);
      const rawAcceptance = record.acceptance;
      let acceptance: string[] = [];

      if (rawAcceptance !== undefined) {
        if (!Array.isArray(rawAcceptance) || rawAcceptance.length > 10) {
          errors.push('create 的 acceptance 必须是字符串数组（最多 10 条）');
          continue;
        }

        const invalid = rawAcceptance.some(
          (item) => typeof item !== 'string' || item.trim() === '' || item.length > 300,
        );

        if (invalid) {
          errors.push('create 的 acceptance 每一条必须是 1–300 字的字符串');
          continue;
        }

        acceptance = rawAcceptance.map((item) => (item as string).trim());
      }

      if (title !== null && goal !== null) {
        actions.push({ action: 'create', title, goal, acceptance });
      }

      continue;
    }

    if (name === 'claim' || name === 'renew' || name === 'release') {
      const cardId = cardIdOf(record, String(name), errors);
      if (cardId === null) continue;

      // A repeated claim in the same reply would only fight itself.
      if (name === 'claim') {
        if (claimed.has(cardId)) continue;
        claimed.add(cardId);
        actions.push({ action: 'claim', cardId });
      } else {
        actions.push({ action: name, cardId });
      }

      continue;
    }

    if (name === 'complete') {
      const cardId = cardIdOf(record, 'complete', errors);
      const result = textOf(record, 'result', MAX_RESULT_CHARS, 'complete', errors);

      if (cardId !== null && result !== null) {
        actions.push({ action: 'complete', cardId, result });
      }

      continue;
    }

    if (name === 'fail') {
      const cardId = cardIdOf(record, 'fail', errors);
      const reason = textOf(record, 'reason', MAX_REASON_CHARS, 'fail', errors);

      if (cardId !== null && reason !== null) {
        actions.push({ action: 'fail', cardId, reason });
      }

      continue;
    }

    if (name === 'post') {
      const cardId = cardIdOf(record, 'post', errors);
      const content = textOf(record, 'content', MAX_POST_CHARS, 'post', errors);
      const kindValue = record.kind === undefined ? 'utterance' : record.kind;

      if (
        typeof kindValue !== 'string' ||
        !(POST_KINDS as readonly string[]).includes(kindValue)
      ) {
        errors.push('post 的 kind 只能是 utterance / question / result / review');
        continue;
      }

      if (cardId !== null && content !== null) {
        actions.push({
          action: 'post',
          cardId,
          content,
          kind: kindValue as PostKind,
        });
      }

      continue;
    }

    errors.push(`不支持的动作：${String(name)}`);
  }

  return { actions, errors };
}

export interface AppliedBoardAction {
  action: BoardAction['action'];
  cardId: string | null;
  ok: boolean;
  detail: string;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;

  return typeof code === 'string' ? code : 'unknown';
}

function leaseClock(card: CardRow): string {
  if (card.claim_expires_at === null) return '未知';

  const date = new Date(card.claim_expires_at);

  return Number.isNaN(date.getTime())
    ? card.claim_expires_at
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function claimFailureText(db: DatabaseSync, cardId: string, code: string): string {
  if (code === 'card_already_claimed') {
    const card = findCard(db, cardId);
    const holder = card?.claimed_by ?? '其他 Agent';

    return `认领失败：「${card?.title ?? cardId}」已被 ${holder} 认领。`;
  }

  if (code === 'too_many_leases') return '认领失败：你手上已有两张未完成的卡，先处理完再认领。';
  if (code === 'card_closed') return '认领失败：这张卡已经结束。';
  if (code === 'card_not_found') return '认领失败：卡不存在。';

  return `认领失败（${code}）。`;
}

function holderFailureText(action: string, code: string): string {
  if (code === 'lease_lost') return `${action}失败：你当前没有这张卡的租约，或租约已过期。`;
  if (code === 'card_closed') return `${action}失败：这张卡已经结束。`;
  if (code === 'card_not_found') return `${action}失败：卡不存在。`;

  return `${action}失败（${code}）。`;
}

function notify(
  db: DatabaseSync,
  conversationId: string,
  input: { cardId: string | null; content: string; requestId: string },
): void {
  try {
    postMessage(db, conversationId, boardSystem(db, conversationId), {
      cardId: input.cardId,
      kind: 'notice',
      content: input.content,
      requestId: input.requestId,
    });
  } catch {
    // A notice that cannot be written must not fail the turn it describes.
    console.warn(`[trinity-core] board notice write failed (conversation=${conversationId})`);
  }
}

function applyClaim(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  sourceId: string,
): AppliedBoardAction {
  const requestId = `${sourceId}:claim:${cardId}`;
  const already = db
    .prepare('SELECT 1 AS ok FROM board_messages WHERE request_id = ?')
    .get(requestId) as { ok: number } | undefined;

  if (already) {
    return { action: 'claim', cardId, ok: true, detail: 'already_applied' };
  }

  const card = findCard(db, cardId);

  if (!card || card.conversation_id !== conversationId) {
    notify(db, conversationId, {
      cardId: null,
      content: `认领失败：卡 ${cardId} 不存在或不属于这个工作区。`,
      requestId,
    });

    return { action: 'claim', cardId, ok: false, detail: 'card_not_found' };
  }

  try {
    const claimed = claimCard(db, cardId, agent);

    notify(db, conversationId, {
      cardId,
      content: `已认领「${claimed.card.title}」，租约保留到 ${leaseClock(claimed.card)}，到期自动释放。`,
      requestId,
    });

    return { action: 'claim', cardId, ok: true, detail: 'claimed' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: claimFailureText(db, cardId, code),
      requestId,
    });

    return { action: 'claim', cardId, ok: false, detail: code };
  }
}

/** Shared guard for the actions that need the agent's own active lease. */
function holderCard(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
): { card: CardRow; token: string } | null {
  const card = findCard(db, cardId);

  if (!card || card.conversation_id !== conversationId) return null;
  if (card.claimed_by !== agent || !card.claim_token) return null;

  return { card, token: card.claim_token };
}

function applyRenew(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  sourceId: string,
): AppliedBoardAction {
  const requestId = `${sourceId}:renew:${cardId}`;
  const held = holderCard(db, conversationId, agent, cardId);

  if (held === null) {
    notify(db, conversationId, {
      cardId: null,
      content: holderFailureText('续租', 'lease_lost'),
      requestId,
    });

    return { action: 'renew', cardId, ok: false, detail: 'lease_lost' };
  }

  try {
    const card = renewCard(db, cardId, agent, held.token);

    notify(db, conversationId, {
      cardId,
      content: `已续租「${card.title}」，租约保留到 ${leaseClock(card)}。`,
      requestId,
    });

    return { action: 'renew', cardId, ok: true, detail: 'renewed' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: holderFailureText('续租', code),
      requestId,
    });

    return { action: 'renew', cardId, ok: false, detail: code };
  }
}

function applyRelease(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  sourceId: string,
): AppliedBoardAction {
  const requestId = `${sourceId}:release:${cardId}`;
  const held = holderCard(db, conversationId, agent, cardId);

  if (held === null) {
    notify(db, conversationId, {
      cardId: null,
      content: holderFailureText('释放', 'lease_lost'),
      requestId,
    });

    return { action: 'release', cardId, ok: false, detail: 'lease_lost' };
  }

  try {
    const card = releaseCard(db, cardId, agent, held.token);

    notify(db, conversationId, {
      cardId,
      content: `已释放「${card.title}」，卡回到待认领。`,
      requestId,
    });

    return { action: 'release', cardId, ok: true, detail: 'released' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: holderFailureText('释放', code),
      requestId,
    });

    return { action: 'release', cardId, ok: false, detail: code };
  }
}

function applyComplete(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  result: string,
  sourceId: string,
): AppliedBoardAction {
  const requestId = `${sourceId}:complete:${cardId}`;
  const held = holderCard(db, conversationId, agent, cardId);

  if (held === null) {
    notify(db, conversationId, {
      cardId: null,
      content: holderFailureText('完成', 'lease_lost'),
      requestId,
    });

    return { action: 'complete', cardId, ok: false, detail: 'lease_lost' };
  }

  try {
    // The agent's own words are the evidence: they become a real message in the
    // conversation, and the card points at it. "Done" without a message is
    // still refused by completeCard.
    const message = messageService.addMessage(
      db,
      conversationId,
      {
        content: result,
        message_type: 'agent_message',
        sender_kind: 'agent',
        sender_id: AGENT_DISPLAY[agent],
      },
      agentActor(agent),
    );

    const card = completeCard(db, cardId, agent, held.token, message.id);

    notify(db, conversationId, {
      cardId,
      content: `已完成「${card.title}」，结果已作为一条真实消息记录。`,
      requestId,
    });

    return { action: 'complete', cardId, ok: true, detail: 'completed' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: holderFailureText('完成', code),
      requestId,
    });

    return { action: 'complete', cardId, ok: false, detail: code };
  }
}

function applyFail(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  reason: string,
  sourceId: string,
): AppliedBoardAction {
  const requestId = `${sourceId}:fail:${cardId}`;
  const held = holderCard(db, conversationId, agent, cardId);

  if (held === null) {
    notify(db, conversationId, {
      cardId: null,
      content: holderFailureText('失败上报', 'lease_lost'),
      requestId,
    });

    return { action: 'fail', cardId, ok: false, detail: 'lease_lost' };
  }

  try {
    const card = failCard(db, cardId, agent, held.token, reason);

    notify(db, conversationId, {
      cardId,
      content: `「${card.title}」已标记失败：${safeSlice(reason, 200)}`,
      requestId,
    });

    return { action: 'fail', cardId, ok: true, detail: 'failed' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: holderFailureText('失败上报', code),
      requestId,
    });

    return { action: 'fail', cardId, ok: false, detail: code };
  }
}

function applyCreate(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  action: { title: string; goal: string; acceptance: string[] },
  sourceId: string,
  index: number,
): AppliedBoardAction {
  const requestId = `${sourceId}:create:${index}`;

  try {
    const card = createCard(
      db,
      conversationId,
      {
        title: action.title,
        goal: action.goal,
        ...(action.acceptance.length > 0 ? { acceptance: action.acceptance } : {}),
      },
      boardAgent(db, conversationId, agent),
    );

    notify(db, conversationId, {
      cardId: card.id,
      content: `${AGENT_DISPLAY[agent]} 建了一张卡：「${card.title}」。`,
      requestId,
    });

    return { action: 'create', cardId: card.id, ok: true, detail: 'created' };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId: null,
      content: `建卡失败（${code}）。`,
      requestId,
    });

    return { action: 'create', cardId: null, ok: false, detail: code };
  }
}

function applyPost(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  cardId: string,
  content: string,
  kind: PostKind,
  sourceId: string,
  index: number,
): AppliedBoardAction {
  const card = findCard(db, cardId);
  const requestId = `${sourceId}:post-error:${index}:${cardId}`;

  if (!card || card.conversation_id !== conversationId) {
    notify(db, conversationId, {
      cardId: null,
      content: `给卡发消息失败：卡 ${cardId} 不存在或不属于这个工作区。`,
      requestId,
    });

    return { action: 'post', cardId, ok: false, detail: 'card_not_found' };
  }

  try {
    postMessage(db, conversationId, boardAgent(db, conversationId, agent), {
      cardId,
      kind: kind as MessageKind,
      content,
      requestId: `${sourceId}:post:${index}:${cardId}`,
    });

    return { action: 'post', cardId, ok: true, detail: kind };
  } catch (err) {
    const code = errorCode(err);

    notify(db, conversationId, {
      cardId,
      content: `给卡发消息失败（${code}）。`,
      requestId,
    });

    return { action: 'post', cardId, ok: false, detail: code };
  }
}

/**
 * Applies the actions an agent wrote in its own final text. Never throws: a bad
 * action is reported on the board, the turn itself has already finished.
 */
export function applyBoardActions(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
  text: string,
  sourceId: string,
): AppliedBoardAction[] {
  const { actions, errors } = parseBoardActions(text);

  if (actions.length === 0 && errors.length === 0) return [];

  if (errors.length > 0) {
    notify(db, conversationId, {
      cardId: null,
      content: `白板动作未能识别：${safeSlice(errors.join('；'), MAX_ERROR_CHARS)}`,
      requestId: `${sourceId}:board-errors`,
    });
  }

  const applied: AppliedBoardAction[] = [];
  let postIndex = 0;
  let createIndex = 0;

  for (const action of actions) {
    switch (action.action) {
      case 'create':
        applied.push(
          applyCreate(db, conversationId, agent, action, sourceId, createIndex),
        );
        createIndex += 1;
        break;

      case 'claim':
        applied.push(applyClaim(db, conversationId, agent, action.cardId, sourceId));
        break;

      case 'renew':
        applied.push(applyRenew(db, conversationId, agent, action.cardId, sourceId));
        break;

      case 'release':
        applied.push(applyRelease(db, conversationId, agent, action.cardId, sourceId));
        break;

      case 'complete':
        applied.push(
          applyComplete(db, conversationId, agent, action.cardId, action.result, sourceId),
        );
        break;

      case 'fail':
        applied.push(
          applyFail(db, conversationId, agent, action.cardId, action.reason, sourceId),
        );
        break;

      case 'post':
        applied.push(
          applyPost(
            db,
            conversationId,
            agent,
            action.cardId,
            action.content,
            action.kind,
            sourceId,
            postIndex,
          ),
        );
        postIndex += 1;
        break;

      default:
        break;
    }
  }

  // A pass is only meaningful when the agent was not claiming anything.
  if (!actions.some((action) => action.action === 'claim')) {
    const pass = actions.find((action) => action.action === 'pass');

    if (pass !== undefined) {
      notify(db, conversationId, {
        cardId: null,
        content: `${agent} 表示本轮不认领白板上的卡。`,
        requestId: `${sourceId}:pass`,
      });
      applied.push({ action: 'pass', cardId: null, ok: true, detail: 'passed' });
    }
  }

  return applied;
}

function jsonList(value: string | null): string[] {
  if (value === null) return [];

  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    );
  } catch {
    return [];
  }
}

/**
 * The board section shown to an agent before its turn. It lists only what
 * exists; it never says who is a good fit or what to do.
 */
export function boardPromptSection(
  db: DatabaseSync,
  conversationId: string,
  agent: HarnessType,
): string | null {
  const all = listCards(db, conversationId, 'open');
  const claimed = db
    .prepare(
      `SELECT * FROM board_cards
        WHERE conversation_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')
          AND claim_expires_at > ?
        ORDER BY created_at
        LIMIT ?`,
    )
    .all(
      conversationId,
      agent,
      new Date().toISOString(),
      MAX_PROMPT_CLAIMED,
    ) as unknown as CardRow[];

  if (all.length === 0 && claimed.length === 0) return null;

  const shown = all.slice(0, MAX_PROMPT_CARDS);
  const lines = shown.map((card) => {
    const parts = [
      `- id=${card.id}`,
      `标题：${card.title}`,
      `目标：${safeSlice(card.goal, GOAL_EXCERPT)}`,
    ];
    const capabilities = jsonList(card.required_capabilities_json);
    const acceptance = jsonList(card.acceptance_json);

    if (capabilities.length > 0) parts.push(`需要能力：${capabilities.join('/')}`);
    if (acceptance.length > 0) parts.push(`验收：${acceptance.join('；')}`);

    return parts.join('｜');
  });

  const sections: string[] = [];

  if (lines.length > 0) {
    const count = all.length > shown.length ? `至少 ${all.length}` : String(all.length);

    sections.push(
      `【白板】当前工作区有 ${count} 张待认领的卡，由用户或其他 Agent 创建：`,
      ...lines,
    );
  }

  if (claimed.length > 0) {
    sections.push(
      '【白板】你当前持有租约的卡：',
      ...claimed.map(
        (card) => `- id=${card.id}｜标题：${card.title}｜租约到 ${leaseClock(card)}`,
      ),
    );
  }

  sections.push(
    '平台不指派任务。要认领一张待认领卡，在回复末尾单独一行、原样输出：',
    `${BOARD_ACTION_MARKER} {"action":"claim","card_id":"<卡 id>"}`,
    '不打算认领任何一张时：',
    `${BOARD_ACTION_MARKER} {"action":"pass"}`,
    '你持有租约时，可以续租、释放、完成、上报失败或给卡发消息：',
    `${BOARD_ACTION_MARKER} {"action":"renew","card_id":"<卡 id>"}`,
    `${BOARD_ACTION_MARKER} {"action":"release","card_id":"<卡 id>"}`,
    `${BOARD_ACTION_MARKER} {"action":"complete","card_id":"<卡 id>","result":"<结果摘要>"}`,
    `${BOARD_ACTION_MARKER} {"action":"fail","card_id":"<卡 id>","reason":"<失败原因>"}`,
    `${BOARD_ACTION_MARKER} {"action":"post","card_id":"<卡 id>","content":"<内容>","kind":"utterance"}`,
    '你也可以发起一张新卡（创建者记为你）：',
    `${BOARD_ACTION_MARKER} {"action":"create","title":"<标题>","goal":"<目标>","acceptance":["<验收项>"]}`,
    'complete 的 result 会被写成一条真实结果消息并关闭卡；没有租约、租约过期或卡不在本工作区时，平台会拒绝并通知你。',
    '这行文字就是动作本身：只有自然语言不会被记录；收到平台的成功通知前，不要声称已经认领或完成。',
    '动作不需要启动命令或读取文件；写下这一行就够。',
    `（本条提示由平台注入；你当前的身份是 ${agent}。）`,
  );

  return sections.join('\n');
}
