import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimRequest,
  issueToken,
  resetTokens,
  revokeToken,
  validateToken,
} from '../src/harnesses/token.service.ts';

function makeToken(maxTasks = 4, ttlMs = 60_000) {
  return issueToken({
    conversationId: 'conv-1',
    sourceAgent: 'claude',
    sourceTurnId: 'turn-1',
    ttlMs,
    maxTasks,
  });
}

test('D3.5.3b.1 令牌：签发后可校验，撤销后失效', () => {
  resetTokens();
  const entry = makeToken();

  assert.equal(validateToken(entry.token).ok, true);
  assert.equal(revokeToken(entry.token), true);

  const after = validateToken(entry.token);
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.reason, 'unknown');
});

test('D3.5.3b.1 令牌：缺失、未知、过期各自给出明确原因', () => {
  resetTokens();

  const missing = validateToken(undefined);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing');

  const unknown = validateToken('not-a-token');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown');

  const expired = makeToken(4, 1000);
  const later = validateToken(expired.token, Date.now() + 5000);
  assert.equal(later.ok, false);
  if (!later.ok) assert.equal(later.reason, 'expired');
});

test('D3.5.3b.1 幂等：同一 request_id 的 10 个并发声明只有一个 owner', async () => {
  resetTokens();
  const entry = makeToken();

  const claims = Array.from({ length: 10 }, () => claimRequest(entry, 'req-1'));

  const owners = claims.filter((claim) => claim.type === 'owner');
  const waiters = claims.filter((claim) => claim.type === 'wait');

  assert.equal(owners.length, 1, '只能有一个请求真正创建任务');
  assert.equal(waiters.length, 9);
  assert.equal(entry.used, 1, '配额只消耗一次');

  const owner = owners[0];
  if (owner?.type !== 'owner') throw new Error('expected an owner');

  owner.settle({ ok: true, taskId: 'task-1', error: null });

  const results = await Promise.all(waiters.map((waiter) => (waiter as { result: Promise<unknown> }).result));
  for (const result of results) {
    assert.deepEqual(result, { ok: true, taskId: 'task-1', error: null });
  }

  const after = claimRequest(entry, 'req-1');
  assert.deepEqual(after, { type: 'reuse', taskId: 'task-1' });
  assert.equal(entry.used, 1);
});

test('D3.5.3b.1 幂等：创建失败会释放预留与配额，可重新尝试', async () => {
  resetTokens();
  const entry = makeToken();

  const first = claimRequest(entry, 'req-1');
  if (first.type !== 'owner') throw new Error('expected an owner');

  const waiter = claimRequest(entry, 'req-1');
  if (waiter.type !== 'wait') throw new Error('expected a waiter');

  const failure = new Error('target_unbound');
  first.settle({ ok: false, taskId: '', error: failure });

  const waited = await waiter.result;
  assert.equal(waited.ok, false);

  assert.equal(entry.used, 0, '失败不占用配额');
  assert.equal(entry.reservations.size, 0, '失败不留下 request_id');

  const retry = claimRequest(entry, 'req-1');
  assert.equal(retry.type, 'owner', '同一 request_id 可以重新尝试');
  assert.equal(entry.used, 1);
});

test('D3.5.3b.1 配额：第 5 个不同 request_id 被拒', () => {
  resetTokens();
  const entry = makeToken(4);

  for (let i = 0; i < 4; i += 1) {
    const claim = claimRequest(entry, `req-${i}`);
    assert.equal(claim.type, 'owner');
    if (claim.type === 'owner') claim.settle({ ok: true, taskId: `task-${i}`, error: null });
  }

  assert.equal(entry.used, 4);
  assert.deepEqual(claimRequest(entry, 'req-5'), { type: 'quota_exceeded' });

  // 已完成的 request_id 仍然可复用，且不消耗配额
  assert.deepEqual(claimRequest(entry, 'req-0'), { type: 'reuse', taskId: 'task-0' });
});

test('D3.5.3b.1 配额：创建中的预留也占名额', () => {
  resetTokens();
  const entry = makeToken(2);

  const a = claimRequest(entry, 'req-a');
  assert.equal(a.type, 'owner');

  const b = claimRequest(entry, 'req-b');
  assert.equal(b.type, 'owner');

  assert.deepEqual(claimRequest(entry, 'req-c'), { type: 'quota_exceeded' });
});
