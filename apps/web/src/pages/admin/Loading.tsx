import { useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { LoadingPreset, LoadingSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useCustomization } from '../../lib/customize';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import {
  DEFAULT_LOADING,
  LOADING_PRESETS,
  loadingEnabled,
  loadingPalette,
  readLoading,
} from '../../lib/loading';
import { resolveTokens } from '../../lib/theme';
import { Badge, Button, Callout, Field, Input, Textarea, Toggle } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { LoadingMark, LoadingScene } from '../../components/LoadingScene';
import { RoleGate } from '../../components/Guards';

export function LoadingPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  useTitle(embedded ? t('主题设置') : t('加载动画'));
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const { customization } = useCustomization();
  const toast = useToast();
  const saved = useMemo(() => readLoading(config), [config]);
  const [draft, setDraft] = useState<LoadingSettings>(() => saved);
  const [replayKey, setReplayKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const tokens = useMemo(() => resolveTokens(customization.theme), [customization.theme]);
  const palette = useMemo(
    () =>
      loadingPalette(draft, {
        background: tokens.background,
        ink: tokens.ink,
        accent: tokens.accent,
      }),
    [draft, tokens],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const patch = (next: Partial<LoadingSettings>) => setDraft({ ...draft, ...next });

  const save = () => {
    const next = readLoading({ loading: draft });
    updateConfig({ loading: next });
    setDraft(next);
    toast.push(
      'ok',
      t('加载动画已保存'),
      next.enabled ? t('前台刷新或切换页面时会按设置显示。') : t('加载动画当前关闭。'),
    );
    if (me) {
      noteActivity(
        backend,
        me.user.display_name,
        '修改加载动画',
        site?.name ?? '站点',
        next.enabled ? `${next.preset} · ${next.min_duration_ms} ms` : '已关闭',
      );
    }
  };

  const reset = () => {
    updateConfig({ loading: DEFAULT_LOADING });
    setDraft(DEFAULT_LOADING);
    toast.push('ok', t('已恢复默认加载动画'), t('加载画面关闭，图形回到圆环。'));
  };

  const body = (
    <>
      {embedded ? (
        <div className="row gap-8 mb-16" style={{ flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            size="sm"
            icon="eye"
            onClick={() => setPreviewOpen(true)}
            disabled={!draft.enabled}
          >
            {t('全屏预览')}
          </Button>
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
          <span className="tiny faint">{t('加载动画只在站点前台出现')}</span>
        </div>
      ) : (
        <div className="admin-page-head">
          <div>
            <h1>{t('加载动画')}</h1>
            <p>
              {t('制作站点首次加载或切换页面时的等待画面。图形、颜色、背景、尺寸与最短展示时长都可以')}{' '}
              {t('调整；管理后台和页面编排预览不会显示，避免影响日常编辑。')}
            </p>
          </div>
          <div className="admin-page-actions">
            <Button
              variant="secondary"
              size="sm"
              icon="eye"
              onClick={() => setPreviewOpen(true)}
              disabled={!draft.enabled}
            >
              {t('全屏预览')}
            </Button>
            <Button size="sm" disabled={!dirty} onClick={save} icon="check">
              {t('保存修改')}
            </Button>
          </div>
        </div>
      )}

      <Callout tone="info" icon="sparkle" title={t('这是站点前台的第一印象')}>
        {t('加载画面只在真正等待时出现。最短展示时长最多 3 秒；如果站长把「切换页面」也打开，')}{' '}
        {t('每次站内导航都会停留这么久，请先用预览确认体感。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('图形')}</h3>
                <p>{t('选择一个预设；预览和真实前台使用同一套 CSS。')}</p>
              </div>
              <Badge tone={draft.enabled ? 'ok' : 'muted'} dot={draft.enabled}>
                {draft.enabled ? t('已启用') : t('未启用')}
              </Badge>
            </div>
            <div className="panel-body">
              <Toggle
                checked={draft.enabled}
                onChange={(enabled) => patch({ enabled })}
                label={t('启用站点加载动画')}
                description={t('只在前台出现；后台、安装向导与编排预览始终不显示。')}
              />
              <div className="loading-preset-grid mt-16">
                {LOADING_PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`loading-preset-card${draft.preset === item.id ? ' is-selected' : ''}`}
                    aria-pressed={draft.preset === item.id}
                    onClick={() => patch({ preset: item.id as LoadingPreset })}
                  >
                    <span
                      className="loading-preset-mark"
                      style={
                        {
                          '--pp-loading-size': '30px',
                          '--pp-loading-accent': palette.accent,
                          '--pp-loading-ink': palette.ink,
                        } as CSSProperties
                      }
                    >
                      <LoadingMark preset={item.id} />
                    </span>
                    <strong>{item.name}</strong>
                    <span>{item.note}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('文案与配色')}</h3>
                <p>{t('强调色和背景可以跟随主题，也可以单独指定。')}</p>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setReplayKey((value) => value + 1)}
              >
                {t('重播预览')}
              </button>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Field
                  label={t('加载文案')}
                  htmlFor="loading-text"
                  aside={`${draft.text.length}/80`}
                  hint={t('留空只显示图形。')}
                >
                  <Input
                    id="loading-text"
                    value={draft.text}
                    maxLength={80}
                    placeholder={t('正在载入')}
                    onChange={(event) => patch({ text: event.target.value })}
                  />
                </Field>
                <div className="form-grid">
                  <Field label={t('强调色')}>
                    <div className="loading-color-row">
                      <button
                        type="button"
                        className={`chip${draft.accent_mode === 'theme' ? ' is-active' : ''}`}
                        onClick={() => patch({ accent_mode: 'theme' })}
                      >
                        {t('跟随主题')}
                      </button>
                      <button
                        type="button"
                        className={`chip${draft.accent_mode === 'custom' ? ' is-active' : ''}`}
                        onClick={() => patch({ accent_mode: 'custom' })}
                      >
                        {t('自定义')}
                      </button>
                      <input
                        type="color"
                        aria-label={t('加载动画强调色')}
                        value={draft.accent}
                        disabled={draft.accent_mode !== 'custom'}
                        onChange={(event) => patch({ accent: event.target.value })}
                      />
                    </div>
                  </Field>
                  <Field label={t('背景')}>
                    <div className="loading-color-row">
                      <button
                        type="button"
                        className={`chip${draft.background_mode === 'theme' ? ' is-active' : ''}`}
                        onClick={() => patch({ background_mode: 'theme' })}
                      >
                        {t('跟随主题')}
                      </button>
                      <button
                        type="button"
                        className={`chip${draft.background_mode === 'custom' ? ' is-active' : ''}`}
                        onClick={() => patch({ background_mode: 'custom' })}
                      >
                        {t('自定义')}
                      </button>
                      <input
                        type="color"
                        aria-label={t('加载动画背景色')}
                        value={draft.background}
                        disabled={draft.background_mode !== 'custom'}
                        onChange={(event) => patch({ background: event.target.value })}
                      />
                    </div>
                  </Field>
                  <NumberField
                    id="loading-size"
                    label={t('图形尺寸')}
                    value={draft.size}
                    min={16}
                    max={160}
                    unit="px"
                    onChange={(size) => patch({ size })}
                  />
                  <NumberField
                    id="loading-duration"
                    label={t('最短展示')}
                    hint={t('避免加载一闪而过；最多 3000 ms。')}
                    value={draft.min_duration_ms}
                    min={0}
                    max={3000}
                    unit="ms"
                    onChange={(min_duration_ms) => patch({ min_duration_ms })}
                  />
                </div>
                <div className="form-stack" style={{ gap: 2 }}>
                  <Toggle
                    checked={draft.show_on_first_load}
                    onChange={(show_on_first_load) => patch({ show_on_first_load })}
                    label={t('首次打开站点时显示')}
                  />
                  <Toggle
                    checked={draft.show_on_navigation}
                    onChange={(show_on_navigation) => patch({ show_on_navigation })}
                    label={t('站内切换页面时显示')}
                    description={t('每次导航都会停留最短展示时长，开启前请确认体感。')}
                  />
                </div>
                {draft.enabled && !loadingEnabled(draft) ? (
                  <Callout tone="warn" icon="alert">
                    {t('两个显示场景都关闭了，加载动画实际上不会出现。')}
                  </Callout>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('实时预览')}</h3>
                <p>{t('使用当前站点的真实主题色模拟前台。')}</p>
              </div>
              <Badge tone="muted">{draft.preset}</Badge>
            </div>
            <div className="panel-body">
              {draft.custom_css ? <style data-pp-loading-css>{draft.custom_css}</style> : null}
              <div
                className="loading-preview-stage"
                style={{ background: palette.background, color: palette.ink }}
              >
                <div key={replayKey} className="loading-preview-scene">
                  <LoadingScene settings={draft} palette={palette} />
                </div>
              </div>
              <p className="field-hint mt-8">
                {t('预览会像真实加载层一样循环播放；点击「全屏预览」可以看到铺满屏幕的效果。')}
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('附加 CSS')}</h3>
                <p>{t('只作用于加载画面，不会进入后台。')}</p>
              </div>
              <Badge tone={draft.custom_css ? 'accent' : 'muted'}>
                {draft.custom_css
                  ? t('{count} 字符', { count: draft.custom_css.length })
                  : t('未使用')}
              </Badge>
            </div>
            <div className="panel-body">
              <Textarea
                value={draft.custom_css}
                onChange={(event) => patch({ custom_css: event.target.value })}
                maxLength={4000}
                style={{ minHeight: 120, fontFamily: 'var(--mono)', fontSize: 12.5 }}
                placeholder={'.pp-loading-text { letter-spacing: .3em; text-transform: uppercase; }'}
                aria-label={t('加载动画 CSS')}
              />
              <p className="field-hint mt-8">
                {t('可用类名：')}
                <code className="mono">.pp-loading-overlay</code>
                {t('、')}
                <code className="mono">.pp-loading-scene</code>
                {t('、')}
                <code className="mono">.pp-loading-text</code>
                {t('。只粘贴自己信任的 CSS。')}
              </p>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前设置')}</h3>
                <p>{t('保存后才在前台生效。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('图形')}</span>
                  <span className="mini-value">{draft.preset}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('最短展示')}</span>
                  <span className="mini-value">{draft.min_duration_ms} ms</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('首次加载')}</span>
                  <span className="mini-value">
                    {draft.show_on_first_load ? t('显示') : t('不显示')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('切换页面')}</span>
                  <span className="mini-value">
                    {draft.show_on_navigation ? t('显示') : t('不显示')}
                  </span>
                </div>
              </div>
              <p className="tiny faint mt-12">
                {t('管理后台与编排预览不会出现加载画面；如果站点被访问限制拦住，拦截页的层级更高。')}
              </p>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认加载动画')}</h3>
            <p>{t('关闭加载画面并回到圆环、跟随主题、450 ms。不会影响主题与页面。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>

      <div className="row gap-8 mt-20">
        <Button disabled={!dirty} onClick={save} icon="check">
          {t('保存修改')}
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={() => setDraft(saved)}>
            {t('放弃未保存的修改')}
          </Button>
        ) : (
          <span className="tiny faint">{t('没有未保存的修改')}</span>
        )}
        <span className="tiny faint">
          <Icon name="sparkle" size={12} /> {t('只影响站点前台')}
        </span>
      </div>

      {previewOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pp-loading-overlay pp-loading-overlay-preview"
              style={
                {
                  '--pp-loading-bg': palette.background,
                  '--pp-loading-ink': palette.ink,
                  '--pp-loading-accent': palette.accent,
                } as CSSProperties
              }
            >
              <button
                type="button"
                className="loading-preview-close"
                onClick={() => setPreviewOpen(false)}
              >
                {t('关闭预览')}
              </button>
              <LoadingScene settings={draft} palette={palette} />
              {draft.custom_css ? <style>{draft.custom_css}</style> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );

  return embedded ? (
    body
  ) : (
    <RoleGate capability="manage_site" need={t('站点管理员')}>{body}</RoleGate>
  );
}
