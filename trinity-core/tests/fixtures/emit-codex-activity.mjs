const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

out({ type: 'thread.started', thread_id: 'thread-activity' });
out({
  type: 'item.completed',
  item: {
    id: 'item_5',
    type: 'file_change',
    changes: [{ path: 'tests/fixtures/fake.txt', kind: 'add' }],
    status: 'completed',
  },
});
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '改好了' } });
out({ type: 'turn.completed', usage: {} });
