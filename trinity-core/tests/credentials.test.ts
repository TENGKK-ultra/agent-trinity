import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  defaultCredentialDir,
  defaultCredentialFile,
  readSecretFile,
} from '../src/harnesses/credentials.ts';
import { resolveClaudeCredentials } from '../src/harnesses/claude.adapter.ts';
import { resolveDshKey } from '../src/harnesses/dsh.adapter.ts';

function tempRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'trinity-credentials-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function envWith(localAppData: string | undefined): NodeJS.ProcessEnv {
  return (localAppData === undefined ? {} : { LOCALAPPDATA: localAppData }) as NodeJS.ProcessEnv;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

test('凭据默认目录位于 LOCALAPPDATA/Trinity/credentials', () => {
  const base = join('C:', 'Users', 'someone', 'AppData', 'Local');
  const env = envWith(base);

  assert.equal(defaultCredentialDir(env), join(base, 'Trinity', 'credentials'));
  assert.equal(
    defaultCredentialFile('claude.key', env),
    join(base, 'Trinity', 'credentials', 'claude.key'),
  );
  assert.equal(defaultCredentialDir(envWith(undefined)), null);
  assert.equal(defaultCredentialFile('claude.key', envWith(undefined)), null);
});

test('readSecretFile：正常文件可用，空、超长、多行、目录、缺失都安全失败', () => {
  const root = tempRoot();

  try {
    const ok = join(root.dir, 'ok.key');
    writeFileSync(ok, '  fake-token-123456\n');
    assert.equal(readSecretFile(ok), 'fake-token-123456');

    const empty = join(root.dir, 'empty.key');
    writeFileSync(empty, '   \n');
    assert.equal(readSecretFile(empty), null);

    const tooLong = join(root.dir, 'long.key');
    writeFileSync(tooLong, 'x'.repeat(4097));
    assert.equal(readSecretFile(tooLong), null);

    const multiline = join(root.dir, 'multi.key');
    writeFileSync(multiline, 'line1\nline2');
    assert.equal(readSecretFile(multiline), null);

    assert.equal(readSecretFile(root.dir), null, '目录按缺失处理');
    assert.equal(readSecretFile(join(root.dir, 'missing.key')), null);
    assert.equal(readSecretFile(null), null);
  } finally {
    root.cleanup();
  }
});

test('Claude：环境变量优先于文件', () => {
  const credentials = resolveClaudeCredentials({
    TRINITY_CLAUDE_AUTH_TOKEN: 'env-token-123456',
    LOCALAPPDATA: 'C:/nowhere',
  } as NodeJS.ProcessEnv);

  assert.equal(credentials.authToken, 'env-token-123456');
  assert.equal(credentials.source, 'env:TRINITY_CLAUDE_AUTH_TOKEN');
});

test('Claude：显式文件路径生效', () => {
  const root = tempRoot();

  try {
    const file = join(root.dir, 'custom.key');
    writeFileSync(file, 'file-token-123456\n');

    const credentials = resolveClaudeCredentials({
      TRINITY_CLAUDE_KEY_FILE: file,
      LOCALAPPDATA: join(root.dir, 'local'),
    } as NodeJS.ProcessEnv);

    assert.equal(credentials.authToken, 'file-token-123456');
    assert.equal(credentials.source, 'file:configured');
  } finally {
    root.cleanup();
  }
});

test('Claude：默认路径取自 LOCALAPPDATA', () => {
  const root = tempRoot();

  try {
    const credentialDir = join(root.dir, 'Trinity', 'credentials');
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, 'claude.key'), 'default-token-123456\n');

    const credentials = resolveClaudeCredentials({ LOCALAPPDATA: root.dir } as NodeJS.ProcessEnv);

    assert.equal(credentials.authToken, 'default-token-123456');
    assert.equal(credentials.source, 'file:default');
  } finally {
    root.cleanup();
  }
});

test('Claude：缺少凭据时明确失败，且不泄露仓库旧路径', () => {
  const root = tempRoot();

  try {
    assert.throws(
      () => resolveClaudeCredentials({ LOCALAPPDATA: root.dir } as NodeJS.ProcessEnv),
      (err: unknown) => {
        const message = messageOf(err);
        assert.match(message, /TRINITY_CLAUDE_AUTH_TOKEN/);
        assert.match(message, /Trinity/);
        assert.equal(message.includes('ds-key'), false);
        return true;
      },
    );
  } finally {
    root.cleanup();
  }
});

test('Claude：仅存在仓库根目录旧密钥时仍然失败', () => {
  const root = tempRoot();

  try {
    // 模拟旧仓库布局：旧密钥在"仓库"里，新目录为空。
    writeFileSync(join(root.dir, 'ds-key-claude.txt'), 'repo-token-123456');

    assert.throws(() =>
      resolveClaudeCredentials({ LOCALAPPDATA: join(root.dir, 'local') } as NodeJS.ProcessEnv),
    );
  } finally {
    root.cleanup();
  }
});

test('Claude：LOCALAPPDATA 缺失时安全失败', () => {
  assert.throws(
    () => resolveClaudeCredentials({} as NodeJS.ProcessEnv),
    (err: unknown) => {
      const message = messageOf(err);
      assert.equal(message.includes('ds-key'), false);
      assert.match(message, /%LOCALAPPDATA%/);
      return true;
    },
  );
});

test('DSH：环境变量优先，其次显式路径，最后默认路径', () => {
  const root = tempRoot();

  try {
    const fromEnv = resolveDshKey({ TRINITY_DSH_API_KEY: 'env-key-123456' } as NodeJS.ProcessEnv);
    assert.equal(fromEnv.apiKey, 'env-key-123456');
    assert.equal(fromEnv.source, 'env:TRINITY_DSH_API_KEY');

    const configured = join(root.dir, 'custom.key');
    writeFileSync(configured, 'file-key-123456\n');
    const fromFile = resolveDshKey({
      TRINITY_DSH_KEY_FILE: configured,
      LOCALAPPDATA: join(root.dir, 'local'),
    } as NodeJS.ProcessEnv);
    assert.equal(fromFile.apiKey, 'file-key-123456');
    assert.equal(fromFile.source, 'file:configured');

    const credentialDir = join(root.dir, 'Trinity', 'credentials');
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, 'deepseek.key'), 'default-key-123456\n');
    const fromDefault = resolveDshKey({ LOCALAPPDATA: root.dir } as NodeJS.ProcessEnv);
    assert.equal(fromDefault.apiKey, 'default-key-123456');
    assert.equal(fromDefault.source, 'file:default');
  } finally {
    root.cleanup();
  }
});

test('DSH：仅存在仓库根目录旧密钥时仍然失败，错误信息不泄露旧路径', () => {
  const root = tempRoot();

  try {
    writeFileSync(join(root.dir, 'ds-key-dsh.txt'), 'repo-key-123456');

    assert.throws(
      () => resolveDshKey({ LOCALAPPDATA: join(root.dir, 'local') } as NodeJS.ProcessEnv),
      (err: unknown) => {
        const message = messageOf(err);
        assert.equal(message.includes('ds-key'), false);
        assert.match(message, /TRINITY_DSH_API_KEY/);
        return true;
      },
    );
  } finally {
    root.cleanup();
  }
});
