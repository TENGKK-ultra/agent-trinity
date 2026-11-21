const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'thread.started', thread_id: 'thread-test' });
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '完成' } });

// Written raw on purpose: JSON.stringify would collapse the duplicated `id`.
process.stdout.write(
  '{"type":"item.completed","item":{"id":"item_3","type":"web_search","id":"call_00_dup","query":"q","action":{"type":"search"},"results":[]}}\n',
);

out({ type: 'turn.completed', usage: {} });
