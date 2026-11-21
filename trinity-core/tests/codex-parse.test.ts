import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConversation } from '../src/conversations/conversation.service.ts';
import { activateBinding } from '../src/harnesses/session.service.ts';
import { normalizeCommandName, parseCodexLine } from '../src/harnesses/codex.adapter.ts';
import { scanObjectKeys } from '../src/harnesses/duplicate-keys.ts';
import { startTurn } from '../src/harnesses/turn.service.ts';
import type { HarnessAdapter } from '../src/harnesses/types.ts';
import { createTempDatabase } from './helpers.ts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'codex-web-search-dup-id.jsonl');
const EMIT_DUP = resolve(import.meta.dirname, 'fixtures', 'emit-codex-dup.mjs');
const EMIT_COMMAND = resolve(import.meta.dirname, 'fixtures', 'emit-codex-command.mjs');

const LINES = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

function lineAt(index: number): string {
  const value = LINES[index];
  if (value === undefined) throw new Error(`fixture line ${index} is missing`);
  return value;
}

test('重复 JSON 键：普通 JSON.parse 只会留下最后一个 id', () => {
  const parsed = JSON.parse(lineAt(0)) as { item: { id: string } };

  // This is the defect the scanner exists for: item_3 is gone without a word.
  assert.equal(parsed.item.id, 'call_00_ljOPVDEeov3ce0dh5VNT8032');
});

test('重复 JSON 键：扫描器同时保留第一个和最后一个值', () => {
  const scan = scanObjectKeys(lineAt(0), 'item', ['id']);

  assert.deepEqual(scan.duplicates, ['id']);
  assert.equal(scan.firstValues.id, 'item_3');
  assert.equal(scan.firstValues['id#last'], 'call_00_ljOPVDEeov3ce0dh5VNT8032');
});

test('重复 JSON 键：适配器把异常写进 frame，而不是静默丢弃', () => {
  const frame = parseCodexLine(lineAt(0));

  assert.ok(frame);
  const anomaly = frame.anomalies?.[0] ?? '';
  assert.match(anomaly, /^duplicate_json_key:item\.id/);
  assert.match(anomaly, /first=item_3/);
  assert.match(anomaly, /last=call_00_ljOPVDEeov3ce0dh5VNT8032/);
});

test('重复 JSON 键：完成态事件同样带异常标记', () => {
  const frame = parseCodexLine(lineAt(1));

  assert.ok(frame);
  assert.equal(frame.anomalies?.length, 1);
});

test('正常事件解析不受影响', () => {
  const frame = parseCodexLine(lineAt(2));

  assert.ok(frame);
  assert.equal(frame.anomalies, undefined);

  const types = (frame.events ?? []).map((event) => event.type);
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('tool_result'));
});

test('没有 item 对象的行不做扫描', () => {
  const frame = parseCodexLine('{"type":"turn.started"}');

  assert.ok(frame);
  assert.equal(frame.anomalies, undefined);
});

test('重复键扫描只作用于目标对象的顶层，不误报嵌套对象', () => {
  const scan = scanObjectKeys('{"item":{"id":"a","meta":{"id":"b"}}}', 'item', ['id']);

  assert.deepEqual(scan.duplicates, []);
  assert.equal(scan.firstValues.id, 'a');
});

test('字符串内容中的键名不算重复键', () => {
  const line = '{"item":{"id":"a","note":"{\\"id\\":\\"b\\"}"}}';
  const scan = scanObjectKeys(line, 'item', ['id']);

  assert.deepEqual(scan.duplicates, []);
  assert.equal(scan.firstValues.id, 'a');
});

test('回合结束后，重复键异常写入 agent_final 元数据', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '异常元数据' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const adapter = {
      type: 'codex',
      displayName: 'Codex',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: () => ({ file: process.execPath, args: [EMIT_DUP], env: {} }),
      parseLine: parseCodexLine,
    } as unknown as HarnessAdapter;

    const { completion } = startTurn(temp.db, conversation.id, session, 'hi', {
      adapter,
      timeoutMs: 15_000,
      cwd: temp.dir,
    });

    await completion;

    const row = temp.db
      .prepare("SELECT metadata_json FROM messages WHERE message_type = 'agent_final'")
      .get() as { metadata_json: string } | undefined;

    assert.ok(row, '回合结束必须写最终消息');
    const metadata = JSON.parse(row.metadata_json) as { schema_anomalies?: string[] };

    assert.ok(metadata.schema_anomalies?.length, '异常必须进入元数据');
    assert.match(metadata.schema_anomalies?.[0] ?? '', /^duplicate_json_key:item\.id/);
  } finally {
    temp.cleanup();
  }
});

const ACTIVITY_FIXTURE = resolve(import.meta.dirname, 'fixtures', 'codex-activity.jsonl');
const EMIT_ACTIVITY = resolve(import.meta.dirname, 'fixtures', 'emit-codex-activity.mjs');

const ACTIVITY_LINES = readFileSync(ACTIVITY_FIXTURE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

function activityLine(index: number): string {
  const value = ACTIVITY_LINES[index];
  if (value === undefined) throw new Error(`activity fixture line ${index} is missing`);
  return value;
}

test('Codex：file_change 映射为已完成的文件变更活动', () => {
  const event = parseCodexLine(activityLine(0))?.events?.[0];

  assert.equal(event?.type, 'tool_call');
  if (event?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(event.name, 'file_change');
  assert.equal(event.ref, 'item_5');
  assert.match(String(event.summary), /新增 tests\/fixtures\/fake\.txt/);
  assert.match(String(event.summary), /修改 tests\/fixtures\/other\.txt/);
});

test('Codex：mcp_tool_call 与 web_search 带各自摘要', () => {
  const mcp = parseCodexLine(activityLine(1))?.events?.[0];
  assert.equal(mcp?.type, 'tool_call');
  if (mcp?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(mcp.name, 'mcp_call');
  assert.equal(mcp.summary, 'node_repl/js · completed');
  assert.equal(mcp.ref, 'item_3');

  const web = parseCodexLine(activityLine(2))?.events?.[0];
  assert.equal(web?.type, 'tool_call');
  if (web?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(web.name, 'web_search');
  assert.match(String(web.summary), /^搜索：site:nodejs\.org/);
  assert.equal(web.ref, 'call_00_ljOPVDEeov3ce0dh5VNT8032');
});

test('Codex：未观察到的 todo_list 仍然安全降级', () => {
  const event = parseCodexLine(activityLine(3))?.events?.[0];

  assert.equal(event?.type, 'unknown');
  if (event?.type !== 'unknown') throw new Error('unexpected event');
  assert.equal(event.rawType, 'todo_list');
});

test('回合级：file_change 摘要进入消息元数据，参数不外泄', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '文件变更' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const adapter = {
      type: 'codex',
      displayName: 'Codex',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: () => ({ file: process.execPath, args: [EMIT_ACTIVITY], env: {} }),
      parseLine: parseCodexLine,
    } as unknown as HarnessAdapter;

    const { completion } = startTurn(temp.db, conversation.id, session, 'hi', {
      adapter,
      timeoutMs: 15_000,
      cwd: temp.dir,
    });

    await completion;

    const row = temp.db
      .prepare("SELECT metadata_json FROM messages WHERE message_type = 'tool_call'")
      .get() as { metadata_json: string } | undefined;

    assert.ok(row, '必须写入工具调用行');
    const metadata = JSON.parse(row.metadata_json) as {
      tool?: string;
      summary?: string;
      input?: unknown;
    };

    assert.equal(metadata.tool, 'file_change');
    assert.match(String(metadata.summary), /新增 tests\/fixtures\/fake\.txt/);
    assert.equal(metadata.input, null);
  } finally {
    temp.cleanup();
  }
});

test('Codex：命令行只保留程序名，带引号路径、裸路径和普通命令都能识别', () => {
  assert.equal(
    normalizeCommandName(
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content x"',
    ),
    'powershell.exe',
  );
  assert.equal(normalizeCommandName('C:\\Tools\\node.exe script.js'), 'node.exe');
  assert.equal(normalizeCommandName('/usr/bin/git status'), 'git');
  assert.equal(normalizeCommandName('npm test'), 'npm');
  assert.equal(normalizeCommandName('   '), 'command');
  assert.equal(normalizeCommandName(null), 'command');
});

test('Codex：命令执行补上调用关联，结果摘要只带退出码', () => {
  const command =
    '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content probe.txt"';
  const line = JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_7',
      type: 'command_execution',
      command,
      aggregated_output: 'hello\n',
      exit_code: 0,
      status: 'completed',
    },
  });

  const events = parseCodexLine(line)?.events ?? [];
  assert.equal(events.length, 2);

  const call = events[0];
  assert.equal(call?.type, 'tool_call');
  if (call?.type !== 'tool_call') throw new Error('unexpected event');
  assert.equal(call.ref, 'item_7');
  assert.equal(call.name, 'powershell.exe', '消息里只能出现程序名');
  assert.equal(call.rawCommand, command, '原始命令只交给调试存储');

  const result = events[1];
  assert.equal(result?.type, 'tool_result');
  if (result?.type !== 'tool_result') throw new Error('unexpected event');
  assert.equal(result.ref, 'item_7');
  assert.equal(result.name, 'powershell.exe');
  assert.equal(result.summary, '退出码 0');
  assert.equal(result.content, 'hello\n');
});

test('回合级：超长输出被截断但活动仍在，退出码不丢', async () => {
  const temp = createTempDatabase();

  try {
    const conversation = createConversation(temp.db, { title: '超长输出' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const adapter = {
      type: 'codex',
      displayName: 'Codex',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: () => ({ file: process.execPath, args: [EMIT_COMMAND], env: {} }),
      parseLine: parseCodexLine,
    } as unknown as HarnessAdapter;

    const { completion } = startTurn(temp.db, conversation.id, session, 'hi', {
      adapter,
      timeoutMs: 15_000,
      cwd: temp.dir,
    });

    await completion;

    const row = temp.db
      .prepare("SELECT content, metadata_json FROM messages WHERE message_type = 'tool_result'")
      .get() as { content: string; metadata_json: string } | undefined;

    assert.ok(row, '超长输出不能让整条活动消失');
    assert.ok(row.content.length < 9_000, '持久化前必须截断');
    assert.match(row.content, /已截断/);
    assert.match(row.content, /共 9000 字符/, '截断标记的计数必须准确');

    const metadata = JSON.parse(row.metadata_json) as { summary?: string };
    assert.equal(metadata.summary, '退出码 1', '正文被截断时退出码不能丢');

    const call = temp.db
      .prepare("SELECT id, content, metadata_json FROM messages WHERE message_type = 'tool_call'")
      .get() as { id: string; content: string; metadata_json: string } | undefined;

    assert.ok(call, '调用行同样保留');
    assert.equal(call.content, 'powershell.exe');
    assert.equal(JSON.parse(call.metadata_json).ref, 'item_9');
    assert.equal(JSON.parse(call.metadata_json).tool, 'powershell.exe');
    assert.equal(call.content.includes('Get-ChildItem'), false, '消息正文不得含命令行');
    assert.equal(call.metadata_json.includes('Get-ChildItem'), false, '元数据不得含命令行');

    const debug = temp.db
      .prepare('SELECT message_id, program, command FROM command_debug')
      .get() as { message_id: string; program: string; command: string } | undefined;

    assert.ok(debug, '原始命令必须留在独立调试表里');
    assert.equal(debug.message_id, call.id);
    assert.equal(debug.program, 'powershell.exe');
    assert.match(debug.command, /Get-ChildItem env:/);
  } finally {
    temp.cleanup();
  }
});

test('回合级：调试表写失败会留警告，但回合仍然完成', async () => {
  const temp = createTempDatabase();
  const warnings: string[] = [];
  const original = console.warn;

  try {
    // The insert has nowhere to go; the turn must not notice.
    temp.db.exec('DROP TABLE command_debug');
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    const conversation = createConversation(temp.db, { title: '写失败' });
    const { session } = activateBinding(temp.db, conversation.id, {
      harnessType: 'codex',
      cwd: temp.dir,
      model: null,
    });

    const adapter = {
      type: 'codex',
      displayName: 'Codex',
      resolveExecutable: () => ({ file: process.execPath, source: 'test' }),
      buildCommand: () => ({ file: process.execPath, args: [EMIT_COMMAND], env: {} }),
      parseLine: parseCodexLine,
    } as unknown as HarnessAdapter;

    const outcome = await startTurn(temp.db, conversation.id, session, 'hi', {
      adapter,
      timeoutMs: 15_000,
      cwd: temp.dir,
    }).completion;

    assert.equal(outcome.status, 'completed');
    assert.equal(warnings.length, 1, '必须留下一条警告');
    assert.match(warnings[0]!, /command_debug write failed/);
    assert.ok(warnings[0]!.includes(conversation.id), '警告要带会话 ID');
    assert.equal(warnings[0]!.includes('Get-ChildItem'), false, '警告不得包含原始命令');

    const messages = temp.db
      .prepare("SELECT COUNT(*) AS total FROM messages WHERE message_type = 'tool_call'")
      .get() as { total: number };

    assert.equal(messages.total, 1, '消息仍然写入');
  } finally {
    console.warn = original;
    temp.cleanup();
  }
});
