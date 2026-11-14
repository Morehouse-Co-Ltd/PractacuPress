import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { LoadingPreset, LoadingSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useSaveSiteConfig } from '../../lib/siteConfigSave';
import { useBackend } from '../../lib/backend';
import { useCustomization } from '../../lib/customize';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import {
  DEFAULT_LOADING,
  LOADING_PRESETS,
  isSkeletonPreset,
  loadingEnabled,
  loadingPalette,
  readLoading,
  skeletonMotion,
} from '../../lib/loading';
import { resolveTokens } from '../../lib/theme';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  SkeletonGrid,
  SkeletonLine,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { LoadingMark, LoadingScene } from '../../components/LoadingScene';
import { RoleGate } from '../../components/Guards';
import { AutoSaveStatus, type AutoSaveState } from '../../components/AutoSaveStatus';

/** 自动保存的防抖时长：停止编辑 700ms 后写回，避免每敲一下都发请求。 */
const AUTOSAVE_DELAY_MS = 700;

export function LoadingPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  useTitle(embedded ? t('主题设置') : t('加载动画'));
  const { config, site, me } = useAuth();
  const saveSiteConfig = useSaveSiteConfig();
  const backend = useBackend();
  const { customization } = useCustomization();
  const toast = useToast();
  const saved = useMemo(() => readLoading(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<LoadingSettings>(() => saved);
  const [replayKey, setReplayKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saveState, setSaveState] = useState<AutoSaveState>('idle');
  const [saveError, setSaveError] = useState('');
  /** 草稿归一化后的真正写入值；签名相同就不再重复保存。 */
  const payload = useMemo(() => readLoading({ loading: draft }), [draft]);
  const payloadKey = JSON.stringify(payload);
  /** 当前草稿签名；保存完成后据此判断期间有没有新的输入。 */
  const payloadKeyRef = useRef(payloadKey);
  payloadKeyRef.current = payloadKey;
  const savedSig = useRef(payloadKey);
  /** 自动保存串行队列：后一次永远排在前一次完成之后，避免并发覆盖。 */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** 上一次同步过的服务端签名；挂载时只记下，不同步也不保存。 */
  const syncedKey = useRef(savedKey);
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
  /** 骨架预设走原位骨架：不盖全屏遮罩，也不看两个显示场景开关。 */
  const skeleton = isSkeletonPreset(draft.preset);
  const motion = skeletonMotion(draft);
  const fullPresets = LOADING_PRESETS.filter((item) => !isSkeletonPreset(item.id));
  const skeletonPresets = LOADING_PRESETS.filter((item) => isSkeletonPreset(item.id));
  const motionLabel =
    motion === 'pulse'
      ? t('呼吸')
      : motion === 'sweep'
        ? t('扫光')
        : motion === 'both'
          ? t('呼吸 + 扫光')
          : '—';

  const patch = (next: Partial<LoadingSettings>) => setDraft({ ...draft, ...next });

  /** 预设卡：骨架组用迷你占位缩略图，全屏组沿用 LoadingMark。 */
  const renderPreset = (item: { id: LoadingPreset; name: string; note: string }) => {
    const itemSkeleton = isSkeletonPreset(item.id);
    return (
      <button
        key={item.id}
        type="button"
        className={`loading-preset-card${draft.preset === item.id ? ' is-selected' : ''}`}
        aria-pressed={draft.preset === item.id}
        onClick={() => patch({ preset: item.id })}
      >
        <span
          className="loading-preset-mark"
          style={
            {
              '--pp-loading-size': '30px',
              '--pp-loading-accent': palette.accent,
              '--pp-loading-ink': palette.ink,
              '--pp-skel-glint': palette.accent,
            } as CSSProperties
          }
        >
          {itemSkeleton ? (
            <span
              className="preset-skel"
              data-pp-skeleton={skeletonMotion({ ...draft, preset: item.id }) ?? undefined}
              aria-hidden
            >
              <SkeletonLine />
              <SkeletonLine width="74%" />
              <SkeletonLine width="58%" />
            </span>
          ) : (
            <LoadingMark preset={item.id} />
          )}
        </span>
        <strong>{item.name}</strong>
        <span>{item.note}</span>
      </button>
    );
  };

  /** 把一次保存排进串行队列；执行时签名已对齐就说明无需再写。 */
  const enqueueSave = (sig: string, next: LoadingSettings) => {
    saveQueue.current = saveQueue.current
      .then(async () => {
        if (sig === savedSig.current) {
          setSaveState('idle');
          return;
        }
        setSaveState('saving');
        const ok = await saveSiteConfig({ loading: next });
        if (!ok) {
          // useSaveSiteConfig 已经提示了服务端拒绝的原因；状态留给下一次编辑重试。
          setSaveState('error');
          return;
        }
        savedSig.current = sig;
        setSaveState('saved');
        toast.push('ok', t('已自动保存'));
        // 与旧的手动保存一致：期间没有新的输入时把草稿归一化成真正写入的值。
        if (payloadKeyRef.current === sig) {
          setDraft(next);
        }
        if (me) {
          const nextSkeleton = isSkeletonPreset(next.preset);
          noteActivity(
            backend,
            me.user.display_name,
            '修改加载动画',
            site?.name ?? '站点',
            next.enabled
              ? nextSkeleton
                ? `${next.preset} · ${t('原位骨架')}`
                : `${next.preset} · ${next.min_duration_ms} ms`
              : t('已关闭'),
          );
        }
      })
      .catch(() => setSaveState('error'));
  };

  // 草稿变化后尾随防抖自动保存：与已保存值一致就不动。
  useEffect(() => {
    if (payloadKey === savedSig.current) {
      setSaveState((state) => (state === 'saving' ? state : 'idle'));
      setSaveError('');
      return;
    }
    setSaveState('pending');
    setSaveError('');
    const timer = window.setTimeout(() => enqueueSave(payloadKey, payload), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // enqueueSave 只依赖 ref 与稳定回调；签名变化才是重新排队的依据。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey]);

  // 服务端配置更新（开屏水合或本页保存完成）时同步草稿：本地有更新的内容就保留，
  // 既避免冲掉正在输入的内容，也避免把刚同步回来的值当成新改动再保存一次。
  useEffect(() => {
    if (syncedKey.current === savedKey) return;
    syncedKey.current = savedKey;
    const next = readLoading(config);
    if (payloadKey === savedSig.current) {
      setDraft(next);
    }
    savedSig.current = JSON.stringify(next);
    // 只跟服务端配置变化同步；payloadKey 故意不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const reset = async () => {
    const next = readLoading({ loading: DEFAULT_LOADING });
    // 先把草稿与签名一起对齐默认值，避免自动保存把恢复前的旧草稿又写回去。
    savedSig.current = JSON.stringify(next);
    setDraft(next);
    setSaveError('');
    const ok = await saveSiteConfig({ loading: next });
    if (!ok) {
      setSaveState('error');
      return;
    }
    setSaveState('saved');
    toast.push('ok', t('已恢复默认加载动画'), t('加载画面关闭，图形回到圆环。'));
  };

  const body = (
    <>
      {embedded ? (
        <div className="row gap-8 mb-16" style={{ flexWrap: 'wrap' }}>
          {skeleton ? null : (
            <Button
              variant="secondary"
              size="sm"
              icon="eye"
              onClick={() => setPreviewOpen(true)}
              disabled={!draft.enabled}
            >
              {t('全屏预览')}
            </Button>
          )}
          <AutoSaveStatus state={saveState} error={saveError} />
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
            {skeleton ? null : (
              <Button
                variant="secondary"
                size="sm"
                icon="eye"
                onClick={() => setPreviewOpen(true)}
                disabled={!draft.enabled}
              >
                {t('全屏预览')}
              </Button>
            )}
            <AutoSaveStatus state={saveState} error={saveError} />
          </div>
        </div>
      )}

      {skeleton ? (
        <Callout tone="info" icon="sparkle" title={t('页面先出现，内容原地补齐')}>
          {t(
            '原位骨架不盖全屏遮罩，也不会等待最短展示时长；数据到达后占位原地换成内容。',
          )}
        </Callout>
      ) : (
        <Callout tone="info" icon="sparkle" title={t('这是站点前台的第一印象')}>
          {t('加载画面只在真正等待时出现。最短展示时长最多 3 秒；如果站长把「切换页面」也打开，')}{' '}
          {t('每次站内导航都会停留这么久，请先用预览确认体感。')}
        </Callout>
      )}

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
              <div className="mt-16">
                <p className="field-label mb-8">{t('全屏加载')}</p>
                <div className="loading-preset-grid">{fullPresets.map(renderPreset)}</div>
              </div>
              <div className="mt-20">
                <p className="field-label mb-8">{t('页面骨架')}</p>
                <div className="loading-preset-grid">{skeletonPresets.map(renderPreset)}</div>
                {skeleton ? (
                  <p className="field-hint mt-12">
                    {t('骨架会出现在内容最终出现的位置；后台与编排预览不显示。')}
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{skeleton ? t('强调色与扫光') : t('文案与配色')}</h3>
                <p>
                  {skeleton
                    ? t('骨架取色跟随主题令牌；强调色作为扫光的高光。')
                    : t('强调色和背景可以跟随主题，也可以单独指定。')}
                </p>
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
                {skeleton ? null : (
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
                )}
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
                  {skeleton ? null : (
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
                  )}
                  {skeleton ? null : (
                    <NumberField
                      id="loading-size"
                      label={t('图形尺寸')}
                      value={draft.size}
                      min={16}
                      max={160}
                      unit="px"
                      onChange={(size) => patch({ size })}
                    />
                  )}
                  {skeleton ? null : (
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
                  )}
                </div>
                {skeleton ? null : (
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
                )}
                {!skeleton && draft.enabled && !loadingEnabled(draft) ? (
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
                <p>
                  {skeleton
                    ? t('迷你页面骨架按当前动效循环播放。')
                    : t('使用当前站点的真实主题色模拟前台。')}
                </p>
              </div>
              <Badge tone="muted">{draft.preset}</Badge>
            </div>
            <div className="panel-body">
              {draft.custom_css ? <style data-pp-loading-css>{draft.custom_css}</style> : null}
              <div
                className="loading-preview-stage"
                style={{ background: palette.background, color: palette.ink }}
              >
                {skeleton ? (
                  <div
                    key={replayKey}
                    className="loading-skeleton-preview"
                    data-pp-skeleton={motion ?? undefined}
                    style={
                      {
                        '--pp-skel-glint': palette.accent,
                        position: 'relative',
                        zIndex: 1,
                        padding: '20px 18px',
                      } as CSSProperties
                    }
                  >
                    {/* 眉题行 */}
                    <SkeletonLine width="84px" />
                    {/* 大标题行 */}
                    <SkeletonLine width="58%" />
                    {/* 正文行 */}
                    <SkeletonLine width="96%" />
                    <SkeletonLine width="86%" />
                    {/* 两列卡片 */}
                    <SkeletonGrid columns={2} count={2} />
                  </div>
                ) : (
                  <div key={replayKey} className="loading-preview-scene">
                    <LoadingScene settings={draft} palette={palette} />
                  </div>
                )}
              </div>
              <p className="field-hint mt-8">
                {skeleton
                  ? t('迷你骨架按当前动效循环播放；强调色只作扫光高光。')
                  : t('预览会像真实加载层一样循环播放；点击「全屏预览」可以看到铺满屏幕的效果。')}
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
                placeholder={
                  skeleton
                    ? '.pp-skel-line { border-radius: 4px; }'
                    : '.pp-loading-text { letter-spacing: .3em; text-transform: uppercase; }'
                }
                aria-label={t('加载动画 CSS')}
              />
              <p className="field-hint mt-8">
                {t('可用类名：')}
                {skeleton ? (
                  <>
                    <code className="mono">.pp-skel</code>
                    {t('、')}
                    <code className="mono">.pp-skel-line</code>
                    {t('、')}
                    <code className="mono">.pp-skel-media</code>
                    {t('、')}
                    <code className="mono">.skeleton</code>
                  </>
                ) : (
                  <>
                    <code className="mono">.pp-loading-overlay</code>
                    {t('、')}
                    <code className="mono">.pp-loading-scene</code>
                    {t('、')}
                    <code className="mono">.pp-loading-text</code>
                  </>
                )}
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
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                {skeleton ? (
                  <>
                    <div className="mini-row">
                      <span className="mini-label">{t('加载方式')}</span>
                      <span className="mini-value">{t('页面骨架')}</span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('动效')}</span>
                      <span className="mini-value">{motionLabel}</span>
                    </div>
                  </>
                ) : (
                  <>
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
                  </>
                )}
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
        <span className="tiny faint">
          <Icon name="sparkle" size={12} /> {t('只影响站点前台')}
        </span>
      </div>

      {!skeleton && previewOpen && typeof document !== 'undefined'
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
