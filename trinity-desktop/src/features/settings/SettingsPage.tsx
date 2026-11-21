import { useEffect, useState } from 'react';
import { roundTone } from '../board/format';
import { useCore } from '../../hooks/useCoreStatus';
import { getTeamSettings, updateTeamSettings } from '../../services/core-api';
import {
  CORE_TARGETS,
  coreTarget,
  isTauriRuntime,
  setCoreUrl,
} from '../../services/core-config';
import type { ThemeChoice } from '../../types';
import { setLanguage, useLanguage, useT } from '../../i18n';
import type { MessageKey } from '../../i18n/messages';

declare const __APP_VERSION__: string;

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

interface SettingsPageProps {
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
}

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: MessageKey }> = [
  { value: 'system', label: 'settings.theme.system' },
  { value: 'light', label: 'settings.theme.light' },
  { value: 'dark', label: 'settings.theme.dark' },
];

export function SettingsPage({ themeChoice, onThemeChange }: SettingsPageProps) {
  const { state } = useCore();
  const t = useT();
  const language = useLanguage();
  const target = coreTarget();
  const [limit, setLimit] = useState(5);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (state !== 'connected') return;

    let alive = true;

    void getTeamSettings()
      .then((settings) => {
        if (alive) setLimit(settings.cross_round_limit);
      })
      .catch(() => {
        // Keeping the default is honest; the save button reports failures.
      });

    return () => {
      alive = false;
    };
  }, [state]);

  const saveLimit = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);

    try {
      const settings = await updateTeamSettings(limit);
      setLimit(settings.cross_round_limit);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const switchTo = (url: string): void => {
    try {
      setCoreUrl(url);
      // Every page holds data fetched from the previous Core; a reload is the
      // only honest way to show the new target everywhere at once.
      window.location.reload();
    } catch {
      // The offered targets are always valid; a failure here means storage is
      // unavailable, and the current target stays in place.
    }
  };

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
      </div>

      <div className="page-body">
        <div className="settings-list">
          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.appearance')}</div>
                <div className="desc">{t('settings.appearance.desc')}</div>
              </div>
              <div className="seg">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-pressed={themeChoice === option.value}
                    onClick={() => onThemeChange(option.value)}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.language')}</div>
                <div className="desc">{t('settings.language.desc')}</div>
              </div>
              <div className="seg">
                <button
                  aria-pressed={language === 'zh'}
                  onClick={() => setLanguage('zh')}
                >
                  中文
                </button>
                <button
                  aria-pressed={language === 'en'}
                  onClick={() => setLanguage('en')}
                >
                  English
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.connection')}</div>
                <div className="desc">{t('settings.connection.desc')}</div>
              </div>
              <span className="mono">{target.display}</span>
              {target.url === null ? (
                <span className="chip chip-danger">{t('settings.connection.reselect')}</span>
              ) : (
                <span
                  className={`chip ${target.label === '测试' ? 'chip-warning' : 'chip-success'}`}
                >
                  {t('settings.connection.envLabel').replace(
                    '{label}',
                    target.label === '测试'
                      ? t('settings.connection.test')
                      : t('settings.connection.prod'),
                  )}
                </span>
              )}
            </div>
            {target.url === null ? (
              <div className="setting-row">
                <div className="grow">
                  <div className="desc">
                    {t('settings.connection.broken')}
                  </div>
                </div>
              </div>
            ) : null}
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {isTauriRuntime()
                    ? t('settings.connection.reload')
                    : t('settings.connection.dev')}
                </div>
              </div>
              {isTauriRuntime() ? (
                <div className="seg">
                  {CORE_TARGETS.map((option) => (
                    <button
                      key={option.url}
                      aria-pressed={target.url === option.url}
                      onClick={() => switchTo(option.url)}
                      title={option.url}
                    >
                      {option.label} {option.detail}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.backend')}</div>
                <div className="desc">Node.js 24 · Trinity Core</div>
              </div>
              <span className={`chip ${state === 'connected' ? 'chip-success' : 'chip-warning'}`}>
                {state === 'connected'
                  ? t('settings.backend.connected')
                  : state === 'connecting'
                    ? t('settings.backend.connecting')
                    : t('settings.backend.offline')}
              </span>
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">API Key</div>
                <div className="desc">{t('settings.apikey.desc')}</div>
              </div>
              <span className="mono">••••••••</span>
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.rounds')}</div>
                <div className="desc">
                  {t('settings.rounds.desc')}
                </div>
              </div>
              <span className={roundTone(limit)}>
                {limit} {t('settings.rounds.unit')}
              </span>
            </div>
            <div className="setting-row">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={limit}
                disabled={state !== 'connected' || saving}
                onChange={(event) => setLimit(Number(event.target.value))}
                style={{ flex: 1 }}
                aria-label="交叉验证轮数"
              />
              <button
                className="btn btn-primary"
                onClick={() => void saveLimit()}
                disabled={state !== 'connected' || saving}
              >
                {saving ? t('settings.saving') : saved ? t('settings.saved') : t('settings.save')}
              </button>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.rounds.scale')}
                </div>
              </div>
            </div>
            {saveError !== null ? (
              <div className="setting-row">
                <div className="grow">
                  <div className="desc">
                    {t('settings.saveFailed')}
                    {saveError}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.guide')}</div>
                <div className="desc">{t('settings.guide.desc')}</div>
              </div>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.guide.send')}
                </div>
              </div>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.guide.board')}
                </div>
              </div>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.guide.workspace')}
                </div>
              </div>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.guide.project')}
                </div>
              </div>
            </div>
            <div className="setting-row">
              <div className="grow">
                <div className="desc">
                  {t('settings.guide.permission')}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="setting-row">
              <div className="grow">
                <div className="title">{t('settings.about')}</div>
                <div className="desc">{t('settings.about.desc')}</div>
              </div>
              <span className="mono">v{APP_VERSION}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
