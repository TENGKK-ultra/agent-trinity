import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.ts';
import { evaluateBindHost, isLoopbackBindHost } from '../src/startup/bind-guard.ts';

const NO_REMOTE = {} as NodeJS.ProcessEnv;
const WITH_REMOTE = { TRINITY_ALLOW_REMOTE: '1' } as NodeJS.ProcessEnv;

function withoutRemoteEnv<T>(run: () => T): T {
  const previous = process.env.TRINITY_ALLOW_REMOTE;
  delete process.env.TRINITY_ALLOW_REMOTE;

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.TRINITY_ALLOW_REMOTE;
    } else {
      process.env.TRINITY_ALLOW_REMOTE = previous;
    }
  }
}

test('绑定守卫：回环地址默认允许', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST', '  127.0.0.1  ']) {
    assert.equal(isLoopbackBindHost(host), true, `应视为回环: ${host}`);
    assert.equal(evaluateBindHost(host, NO_REMOTE).allowed, true, `应允许: ${host}`);
  }
});

test('绑定守卫：非回环地址默认拒绝', () => {
  const denied = [
    '0.0.0.0',
    '::',
    '[::]',
    '*',
    '',
    '   ',
    '192.168.1.8',
    '10.0.0.5',
    '172.18.0.1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:0:0:1',
  ];

  for (const host of denied) {
    assert.equal(evaluateBindHost(host, NO_REMOTE).allowed, false, `应拒绝: "${host}"`);
  }
});

test('绑定守卫：TRINITY_ALLOW_REMOTE 必须严格等于字符串 1', () => {
  for (const value of ['true', 'TRUE', 'yes', 'on', '01', ' 1', '1 ', '']) {
    assert.equal(
      evaluateBindHost('0.0.0.0', { TRINITY_ALLOW_REMOTE: value }).allowed,
      false,
      `不应授权: "${value}"`,
    );
  }

  assert.equal(evaluateBindHost('0.0.0.0', WITH_REMOTE).allowed, true);
  assert.equal(evaluateBindHost('192.168.1.8', WITH_REMOTE).allowed, true);
});

test('绑定守卫：拒绝非回环地址时不创建数据库文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-guard-deny-'));
  const dbPath = join(dir, 'should-not-exist.db');

  try {
    withoutRemoteEnv(() => {
      assert.throws(
        () => startServer({ dbPath, port: 0, host: '0.0.0.0' }),
        /refusing to listen on non-loopback address/i,
      );
    });

    assert.equal(existsSync(dbPath), false, '被拒绝时不应打开或创建数据库');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('绑定守卫：回环地址可正常启动且实际绑定 127.0.0.1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-guard-allow-'));
  const dbPath = join(dir, 'ok.db');
  const running = startServer({ dbPath, port: 0, host: '127.0.0.1' });

  try {
    await new Promise<void>((resolve) => running.server.once('listening', () => resolve()));

    const address = running.server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1');
  } finally {
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
    running.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
