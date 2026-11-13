import { useEffect, useRef, useState } from 'react';
import type { ArticleCover } from '../types';
import { isDemo, useBackend } from '../lib/backend';
import { useMediaSrc } from '../lib/assetUrl';
import { MAX_COVERS, coverUrlError, normalizeCoverUrl, useCustomization } from '../lib/customize';
import { coverAlt, coverFor, coverFrameStyle, coverImageStyle } from '../lib/covers';
import { usePermissions } from '../lib/usePermissions';
import { useToast } from '../lib/toast';
import { useT } from '../lib/i18n';
import { Badge, Button, Callout, Field, Input, Progress, Toggle } from './ui';
import { Cover } from './Cover';

/**
 * 创作页右侧「封面」面板。
 *
 * 封面是展示层配置：按内容 id 存进 `SiteCustomization.covers`，不写入稿件正文。
 * 面板本身不落任何后端请求，只有上传图片会走 `backend.upload(file, 'site')`。
 */

type CoverPosition = NonNullable<ArticleCover['position']>;

/** 演示模式把图片读成 data URL 存进浏览器配置，超过这个大小就建议换图。 */
const DEMO_IMAGE_LIMIT = 600 * 1024;

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml';

function readableUrl(cover: ArticleCover | undefined): string {
  // data URL 动辄几十万字符，塞进输入框只会卡界面；上传的图片只做预览。
  return cover?.url && !cover.url.startsWith('data:') ? cover.url : '';
}

export function ArticleCoverPanel({
  contentId,
  title,
}: {
  /** 当前内容 id；新建但还没保存的稿件为空。 */
  contentId?: string;
  /** 当前标题，用于程序化封面预览与图片 alt 回退。 */
  title: string;
}) {
  const t = useT();
  const { customization, update } = useCustomization();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { can } = usePermissions();
  const saved = coverFor(customization, contentId);
  const canWrite = can('write_content');
  const disabled = !canWrite || !contentId;

  const [url, setUrl] = useState(() => readableUrl(saved));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState<CoverPosition>(saved?.position ?? 'center');
  const [hidden, setHidden] = useState(!!saved?.hidden);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // 封面通常 purpose=site 可以匿名读，但手工贴的 /api/v1/media 地址可能是
  // content 用途，匿名请求会被挡成 404，所以预览也走带鉴权的 blob；
  // data URL（演示模式上传）原样返回。
  const preview = saved?.url && !hidden ? saved : null;
  const previewSrc = useMediaSrc(preview?.url);

  useEffect(() => {
    // 只在切换稿件（含新稿保存后拿到 id）时回填；写入配置也会更新 customization，
    // 但不能借此覆盖用户正在输入的地址。
    setUrl(readableUrl(saved));
    setTouched(false);
    setError('');
    setPosition(saved?.position ?? 'center');
    setHidden(!!saved?.hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId]);

  /** 写入一份封面配置：先删掉同 id 的旧条目再按需追加，其他内容的封面保持不动。 */
  const commit = (next: ArticleCover | null): boolean => {
    if (!contentId) return false;
    const others = customization.covers.filter((entry) => entry.id !== contentId);
    if (next && others.length >= MAX_COVERS) {
      toast.push(
        'error',
        t('最多保存 {count} 张自定义封面', { count: MAX_COVERS }),
        t('先清除一张不再使用的封面。'),
      );
      return false;
    }
    update({ covers: next ? [...others, next] : others });
    return true;
  };

  /** 以已保存的配置为底，叠加当前面板里的焦点 / 隐藏状态。 */
  const build = (patch: Partial<ArticleCover> = {}): ArticleCover => ({
    id: contentId ?? '',
    url: saved?.url ?? '',
    ...(saved?.alt ? { alt: saved.alt } : {}),
    position,
    hidden,
    ...patch,
  });

  const applyUrl = () => {
    if (disabled) return;
    const value = url.trim();
    if (!value) {
      // 用户手工删掉地址才视为撤掉自定义图片；点一下「应用」或只是失焦不触发。
      if (touched && saved && commit(null)) {
        toast.push('ok', t('已清除封面'), t('这篇内容会重新使用自动生成的封面。'));
      }
      return;
    }
    const message = coverUrlError(value);
    if (message) {
      setError(message);
      return;
    }
    const normalized = normalizeCoverUrl(value);
    if (!normalized) {
      setError(t('这个地址不能用作封面，请换成图片地址或直接上传图片。'));
      return;
    }
    setError('');
    if (normalized === saved?.url && !hidden) return;
    setUrl(readableUrl({ ...build(), url: normalized }));
    // 贴了新地址就认为用户想看到它：取消隐藏并一起写入。
    setHidden(false);
    if (commit(build({ url: normalized, hidden: false }))) {
      toast.push('ok', t('封面已更新'), t('列表、首页卡片与详情页都会使用这张图片。'));
    }
  };

  const applyPosition = (next: CoverPosition) => {
    setPosition(next);
    // 还没有图片地址时只记下选择，等填了地址再一起写入。
    if (disabled || !saved?.url) return;
    commit(build({ position: next }));
  };

  const toggleHidden = (next: boolean) => {
    setHidden(next);
    if (disabled) return;
    // hidden 表示整块不显示封面（连程序化封面也不显示），没有图片地址时也要落盘。
    if (!next && !saved?.url) {
      if (saved) commit(null);
      return;
    }
    commit(build({ hidden: next }));
  };

  const upload = async (file: File) => {
    if (disabled) return;
    setError('');
    if (!file.type.startsWith('image/')) {
      setError(t('请选择图片文件（PNG / JPEG / WebP / GIF）。'));
      return;
    }
    if (demo && file.size > DEMO_IMAGE_LIMIT) {
      setError(t('演示模式把图片以 data URL 存进浏览器配置，请选择 600 KB 以内的图片。'));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const asset = await backend.upload(file, 'site', setProgress);
      if (!asset.url) throw new Error(t('服务端没有返回图片地址。'));
      const normalized = normalizeCoverUrl(asset.url);
      if (!normalized) throw new Error(t('上传结果不能用作封面地址。'));
      setUrl(readableUrl({ id: contentId ?? '', url: normalized }));
      setTouched(false);
      setHidden(false);
      if (commit(build({ url: normalized, hidden: false }))) {
        toast.push(
          'ok',
          t('封面已更新'),
          demo
            ? t('演示模式的图片保存在浏览器里，导出配置时会一起带走。')
            : t('已使用上传的图片。'),
        );
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : t('上传失败。');
      setError(text);
      toast.push('error', t('上传失败'), text);
    } finally {
      setBusy(false);
      setProgress(0);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clear = () => {
    if (disabled) return;
    setUrl('');
    setTouched(false);
    setError('');
    setPosition('center');
    setHidden(false);
    if (saved && commit(null)) {
      toast.push('ok', t('已清除封面'), t('这篇内容会重新使用自动生成的封面。'));
    }
  };

  const status = hidden ? (
    <Badge tone="muted">{t('已隐藏')}</Badge>
  ) : preview ? (
    <Badge tone="accent">{t('自定义')}</Badge>
  ) : (
    <Badge tone="muted">{t('自动生成')}</Badge>
  );
  const positionOptions: { value: CoverPosition; label: string }[] = [
    { value: 'center', label: t('居中') },
    { value: 'top', label: t('顶部') },
    { value: 'bottom', label: t('底部') },
  ];

  return (
    <div className="panel pcov-panel">
      <div className="panel-head">
        <div>
          <h3>{t('封面')}</h3>
          <p>{t('列表、首页卡片与详情页优先显示这里的图片。')}</p>
        </div>
        {status}
      </div>
      <div className="panel-body pcov-body">
        {!contentId ? (
          <Callout tone="info" icon="info">
            {t('先保存草稿，之后可以给这篇内容设置封面。')}
          </Callout>
        ) : !canWrite ? (
          <Callout tone="warn" icon="lock">
            {t('当前账户没有编辑权限，只能查看封面配置。')}
          </Callout>
        ) : null}

        <div className="pcov-preview">
          {preview ? (
            <div className="cover cover-custom" style={coverFrameStyle('16 / 9')}>
              <img
                src={previewSrc.src || undefined}
                alt={coverAlt(preview, title || t('封面'))}
                loading="lazy"
                style={coverImageStyle(preview)}
              />
            </div>
          ) : saved && hidden ? (
            <div className="pcov-hidden">
              <strong>{t('封面已隐藏')}</strong>
              <span>{t('前台列表与详情页都不显示封面；取消勾选即可恢复。')}</span>
            </div>
          ) : (
            <Cover seed={contentId ?? 'draft'} label={title || t('未命名')} ratio="16 / 9" />
          )}
        </div>

        <Field
          label={t('图片地址')}
          htmlFor="pcov-url"
          error={error || null}
          hint={
            demo
              ? t('可以粘贴 http(s) 地址、站内路径或图片 data URL（含 SVG）；直接上传的图片建议 600 KB 以内。')
              : t('支持 http(s) 图片地址、以 / 开头的站内路径与 data:image（含 SVG），也可以直接上传图片。')
          }
        >
          <div className="pcov-url-row">
            <Input
              id="pcov-url"
              value={url}
              disabled={disabled}
              placeholder={t('https://… 或 /uploads/cover.jpg')}
              onChange={(event) => {
                setUrl(event.target.value);
                setTouched(true);
                setError('');
              }}
              onBlur={() => {
                if (touched) {
                  applyUrl();
                  setTouched(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyUrl();
                  setTouched(false);
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => {
                applyUrl();
                setTouched(false);
              }}
            >
              {t('应用')}
            </Button>
          </div>
        </Field>

        <div className="pcov-upload">
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="upload"
            loading={busy}
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            {t('上传图片')}
          </Button>
          <span className="pcov-hint">
            {busy
              ? t('上传中 {progress}%', { progress })
              : demo
                ? t('演示模式：图片以 data URL 保存，建议 600 KB 以内。')
                : t('PNG / JPEG / WebP / GIF / SVG；上传后由服务端检查。')}
          </span>
        </div>
        {busy ? <Progress value={progress} /> : null}

        <div className="pcov-pos">
          <span className="pcov-label">{t('焦点位置')}</span>
          <div className="seg" role="group" aria-label={t('图片焦点位置')}>
            {positionOptions.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={position === entry.value ? 'is-on' : ''}
                disabled={disabled}
                onClick={() => applyPosition(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <Toggle
          checked={hidden}
          disabled={disabled}
          onChange={toggleHidden}
          label={t('隐藏封面')}
          description={t('列表与详情页都不显示封面；配置会保留，随时可以恢复。')}
        />

        <div className="pcov-foot">
          <Button variant="ghost" size="sm" icon="trash" disabled={disabled || !saved} onClick={clear}>
            {t('清除封面')}
          </Button>
          <span className="pcov-hint">
            {preview
              ? t('当前使用自定义图片。')
              : saved?.hidden
                ? t('当前封面已隐藏。')
                : t('当前使用自动生成的装饰封面。')}
          </span>
        </div>
      </div>
    </div>
  );
}
