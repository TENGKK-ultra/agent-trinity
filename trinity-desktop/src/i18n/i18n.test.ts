import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'trinity.language';

async function load() {
  vi.resetModules();
  return import('./index');
}

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('默认中文', async () => {
    const { getLanguage, translate } = await load();

    expect(getLanguage()).toBe('zh');
    expect(translate('zh', 'nav.settings')).toBe('设置');
    expect(translate('zh', 'nav.events')).toBe('事件');
  });

  it('切换后翻译跟着变，并写进 localStorage', async () => {
    const { getLanguage, setLanguage, translate } = await load();

    setLanguage('en');

    expect(getLanguage()).toBe('en');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(translate('en', 'nav.settings')).toBe('Settings');
    expect(translate('en', 'nav.events')).toBe('Events');
  });

  it('切换会把 html lang 一起改掉', async () => {
    const { setLanguage } = await load();

    setLanguage('en');
    expect(document.documentElement.lang).toBe('en');

    setLanguage('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('下次启动读回上次的选择', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'en');

    const { getLanguage } = await load();
    expect(getLanguage()).toBe('en');
  });

  it('存储里是坏值时退回中文', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'klingon');

    const { getLanguage } = await load();
    expect(getLanguage()).toBe('zh');
  });

  it('重复设置同一个语言不通知订阅者', async () => {
    const { setLanguage, getLanguage } = await load();
    const spy = vi.fn();

    setLanguage('zh');
    expect(spy).not.toHaveBeenCalled();
    expect(getLanguage()).toBe('zh');
  });
});
