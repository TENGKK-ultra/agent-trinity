import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreRequestBase,
  coreTarget,
  getCoreUrl,
  PROD_CORE_URL,
  resetCoreUrl,
  resolveCoreConfig,
  setCoreUrl,
  TEST_CORE_URL,
} from './core-config';

function asTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function asBrowser(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('Core 连接目标', () => {
  beforeEach(() => {
    resetCoreUrl();
    asTauri();
  });

  afterEach(() => {
    resetCoreUrl();
    asBrowser();
    vi.restoreAllMocks();
  });

  it('从未配置时默认生产 Core', () => {
    expect(resolveCoreConfig()).toEqual({ kind: 'default', url: PROD_CORE_URL });
    expect(getCoreUrl()).toBe(PROD_CORE_URL);
    expect(coreTarget()).toEqual({
      url: PROD_CORE_URL,
      label: '生产',
      display: '127.0.0.1:3210',
    });
  });

  it('用户明确选择测试环境后保留测试环境', () => {
    expect(setCoreUrl(TEST_CORE_URL)).toBe(TEST_CORE_URL);
    expect(resolveCoreConfig()).toEqual({ kind: 'configured', url: TEST_CORE_URL });
    expect(getCoreUrl()).toBe(TEST_CORE_URL);
    expect(coreTarget()).toEqual({
      url: TEST_CORE_URL,
      label: '测试',
      display: '127.0.0.1:3211',
    });
  });

  it('配置损坏时 fail closed，不自动切回生产', () => {
    for (const broken of ['not-a-url', 'http://10.0.0.5:3210', 'http://127.0.0.1:9999', '']) {
      window.localStorage.setItem('trinity.core-url', broken);

      expect(resolveCoreConfig().kind).toBe('invalid');
      expect(getCoreUrl()).toBeNull();
      expect(coreTarget()).toEqual({
        url: null,
        label: null,
        display: '连接目标无效',
      });
      expect(() => coreRequestBase()).toThrow(/配置异常/);
    }
  });

  it('配置损坏后用户重新选择即可恢复', () => {
    window.localStorage.setItem('trinity.core-url', 'broken');
    expect(getCoreUrl()).toBeNull();

    setCoreUrl(TEST_CORE_URL);
    expect(getCoreUrl()).toBe(TEST_CORE_URL);
    expect(coreRequestBase()).toBe(TEST_CORE_URL);
  });

  it('存储本身不可读时同样 fail closed', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(resolveCoreConfig()).toEqual({ kind: 'invalid', raw: null });
    expect(getCoreUrl()).toBeNull();
  });

  it('持久化只接受本机回环的 3210 / 3211', () => {
    expect(() => setCoreUrl('http://10.0.0.5:3211')).toThrow(/本机回环/);
    expect(() => setCoreUrl('http://127.0.0.1:3212')).toThrow(/本机回环/);
    expect(() => setCoreUrl('https://example.com')).toThrow(/本机回环/);

    // A rejected value must not replace the working one.
    setCoreUrl(TEST_CORE_URL);
    expect(() => setCoreUrl('http://127.0.0.1:9999')).toThrow();
    expect(getCoreUrl()).toBe(TEST_CORE_URL);
  });

  it('重置后回到“从未配置”的生产默认值', () => {
    setCoreUrl(TEST_CORE_URL);
    resetCoreUrl();
    expect(resolveCoreConfig().kind).toBe('default');
    expect(getCoreUrl()).toBe(PROD_CORE_URL);
  });

  it('打包桌面端使用绝对地址，浏览器预览走同源代理', () => {
    asTauri();
    expect(coreRequestBase()).toBe(PROD_CORE_URL);

    asBrowser();
    expect(coreRequestBase()).toBe('');
    expect(coreTarget().label).toBe('生产');
  });
});
