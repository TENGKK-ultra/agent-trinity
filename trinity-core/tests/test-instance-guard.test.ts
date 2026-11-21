import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertTestInstanceIsolated } from '../src/startup/test-guard.ts';

const DEFAULT_DB = resolve('E:/Trinity/trinity-core/data/trinity.db');
const TEST_DB = resolve('E:/Trinity/trinity-core/data/test/trinity-p3.db');

test('测试实例：拒绝使用生产数据库路径', () => {
  assert.throws(
    () =>
      assertTestInstanceIsolated({
        env: 'test',
        dbPath: DEFAULT_DB,
        port: 3211,
        defaultDbPath: DEFAULT_DB,
      }),
    /生产数据库路径/,
  );
});

test('测试实例：拒绝占用生产端口', () => {
  assert.throws(
    () =>
      assertTestInstanceIsolated({
        env: 'test',
        dbPath: TEST_DB,
        port: 3210,
        defaultDbPath: DEFAULT_DB,
      }),
    /生产端口/,
  );
});

test('测试实例：独立端口与独立数据库可以启动', () => {
  assert.doesNotThrow(() =>
    assertTestInstanceIsolated({
      env: 'test',
      dbPath: TEST_DB,
      port: 3211,
      defaultDbPath: DEFAULT_DB,
    }),
  );
});

test('非测试环境保持原行为', () => {
  for (const env of [undefined, '', 'prod', 'production']) {
    assert.doesNotThrow(() =>
      assertTestInstanceIsolated({
        env,
        dbPath: DEFAULT_DB,
        port: 3210,
        defaultDbPath: DEFAULT_DB,
      }),
    );
  }
});
