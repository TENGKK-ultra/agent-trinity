// Mimics the shape a provider uses when it asks the host for a decision:
// a control_request on stdout, then it waits for a control_response on stdin
// before it finishes the turn.
import { createInterface } from 'node:readline';

const sid = 'sid-approval';
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'system', subtype: 'init', session_id: sid });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let asked = false;
let answered = false;

rl.on('line', (line) => {
  let message;

  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === 'user' && !asked) {
    asked = true;
    out({
      type: 'assistant',
      session_id: sid,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Write',
            input: { file_path: 'probe.txt', content: 'hello' },
          },
        ],
      },
    });
    out({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        display_name: 'Write',
        input: { file_path: 'probe.txt', content: 'hello' },
        description: 'probe.txt',
        tool_use_id: 'tu-1',
      },
    });
    return;
  }

  if (message.type === 'control_response' && !answered) {
    answered = true;
    const body = message.response?.response ?? {};
    const allowed = body.behavior === 'allow';

    out({
      type: 'user',
      session_id: sid,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [
              { type: 'text', text: allowed ? 'File created' : String(body.message ?? 'denied') },
            ],
            ...(allowed ? {} : { is_error: true }),
          },
        ],
      },
    });
    out({
      type: 'assistant',
      session_id: sid,
      message: { content: [{ type: 'text', text: allowed ? '已写入' : '没有写入' }] },
    });
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: allowed ? '已写入' : '没有写入',
      session_id: sid,
    });
  }
});
