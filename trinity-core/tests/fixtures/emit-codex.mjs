const threadId = 'cx-thread-1';

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'thread.started', thread_id: threadId });
// Configuration warnings arrive as error items but the turn still succeeds.
out({
  type: 'item.completed',
  item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 2 unrecognized settings.' },
});
out({ type: 'turn.started' });
out({
  type: 'item.completed',
  item: { id: 'item_1', type: 'agent_message', text: '第一段' },
});
out({
  type: 'item.completed',
  item: { id: 'item_2', type: 'agent_message', text: '第二段' },
});
out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
