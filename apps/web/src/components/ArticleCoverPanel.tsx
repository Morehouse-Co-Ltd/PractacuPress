import { useEffect, useRef, useState } from 'react';
import type { ArticleCover } from '../types';
import { isDemo, useBackend } from '../lib/backend';
import { useMediaSrc } from '../lib/assetUrl';
import { coverUrlError, normalizeCoverUrl } from '../lib/customize';
import { coverAlt, coverFrameStyle, coverImageStyle } from '../lib/covers';
import { usePermissions } from '../lib/usePermissions';
import { useToast } from '../lib/toast';
import { useT } from '../lib/i18n';
import { Badge, Button, Callout, Field, Input, Progress, Toggle } from './ui';
import { Cover } from './Cover';

/**
 * 创作页右侧「封面」面板（Beta 1.2 起封面是内容字段）。
 *
 * 以前封面按内容 id 挂在 `SiteCustomization.covers`（站点外观配置）里，导出、订阅源
 * 与分享卡都拿不到它——那份配置不属于内容。现在面板只编辑表单里的
 * `cover_url / cover_alt / cover_position / cover_hidden`，随 `DraftInput` 一起提交。
 *
 * 兼容读旧数据：打开旧内容时，如果内容字段为空而站点外观配置里还有该 id 的封面，
 * 编辑器会把它读进表单（见 `Editor.tsx` 的 `loadContentIntoForm`），保存一次就写进
 * 内容字段；这是一次性读穿迁移，面板本身不再写 `SiteCustomization`，因此不会出现
 * 两份数据互相覆盖。
 */

type CoverPosition = NonNullable<ArticleCover['position']>;

/** 面板编辑的四个封面字段，与 `DraftInput` 的封面字段一一对应。 */
export interface CoverFields {
  cover_url: string;
  cover_alt: string;
  cover_position: CoverPosition;
  cover_hidden: boolean;
}

/** 演示模式把图片读成 data URL 存进内容字段，超过这个大小就建议换图。 */
const DEMO_IMAGE_LIMIT = 600 * 1024;

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml';

function readableUrl(url?: string): string {
  // data URL 动辄几十万字符，塞进输入框只会卡界面；内联图片只做预览。
  return url && !url.startsWith('data:') ? url : '';
}

export function ArticleCoverPanel({
  contentId,
  title,
  value,
  onChange,
}: {
  /** 当前内容 id；新建但还没保存的稿件为空。 */
  contentId?: string;
  /** 当前标题，用于程序化封面预览与图片 alt 回退。 */
  title: string;
  /** 表单里的封面字段（来自 `FormState`，随草稿一起保存）。 */
  value: CoverFields;
  /** 把改动写回表单；面板不直接调用后端，也不写站点外观配置。 */
  onChange: (patch: Partial<CoverFields>) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { can } = usePermissions();
  const canWrite = can('write_content');
  // 新建内容还没有 id，上传与预览都以内容为宿主，所以先保存草稿再设封面。
  const disabled = !canWrite || !contentId;

  const [url, setUrl] = useState(() => readableUrl(value.cover_url));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // 只在切换稿件（含新稿保存后拿到 id）时回填输入框；输入过程中不跟着表单走，
  // 否则每次 onChange 都会重灌输入框，光标会跳。
  useEffect(() => {
    setUrl(readableUrl(value.cover_url));
    setTouched(false);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId]);

  // 预览需要 ArticleCover 形状（`coverImageStyle` / `coverAlt` 的入参），由表单字段现算。
  const cover: ArticleCover | null = value.cover_url
    ? {
        id: contentId ?? '',
        url: value.cover_url,
        ...(value.cover_alt.trim() ? { alt: value.cover_alt.trim() } : {}),
        position: value.cover_position,
        hidden: value.cover_hidden,
      }
    : null;
  const preview = cover && !value.cover_hidden ? cover : null;
  // 封面通常 purpose=site 可以匿名读，但手工贴的 /api/v1/media 地址可能是
  // content 用途，匿名请求会被挡成 404，所以预览也走带鉴权的 blob；
  // data URL（演示模式上传）原样返回。
  const previewSrc = useMediaSrc(preview?.url);

  const applyUrl = () => {
    if (disabled) return;
    const raw = url.trim();
    if (!raw) {
      // 用户手工删掉地址才视为撤掉自定义图片；点一下「应用」或只是失焦不触发。
      if (touched && value.cover_url) {
        onChange({ cover_url: '', cover_alt: '' });
        toast.push('ok', t('已清除封面'), t('这篇内容会重新使用自动生成的封面。'));
      }
      return;
    }
    const message = coverUrlError(raw);
    if (message) {
      setError(message);
      return;
    }
    const normalized = normalizeCoverUrl(raw);
    if (!normalized) {
      setError(t('这个地址不能用作封面，请换成图片地址或直接上传图片。'));
      return;
    }
    setError('');
    if (normalized === value.cover_url && !value.cover_hidden) return;
    setUrl(readableUrl(normalized));
    // 贴了新地址就认为用户想看到它：取消隐藏并一起写进表单。
    onChange({ cover_url: normalized, cover_hidden: false });
    toast.push('ok', t('封面已更新'), t('保存后，列表、首页卡片与详情页都会使用这张图片。'));
  };

  const applyPosition = (next: CoverPosition) => {
    if (disabled) return;
    // 只记下选择：没有图片地址时也写进表单，等填了地址就能直接用上。
    onChange({ cover_position: next });
  };

  const toggleHidden = (next: boolean) => {
    if (disabled) return;
    // hidden 表示整块不显示封面（连程序化封面也不显示），没有图片地址时也要落盘。
    onChange({ cover_hidden: next });
  };

  const upload = async (file: File) => {
    if (disabled) return;
    setError('');
    if (!file.type.startsWith('image/')) {
      setError(t('请选择图片文件（PNG / JPEG / WebP / GIF）。'));
      return;
    }
    if (demo && file.size > DEMO_IMAGE_LIMIT) {
      setError(t('演示模式把图片以 data URL 存进内容字段，请选择 600 KB 以内的图片。'));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const asset = await backend.upload(file, 'site', setProgress);
      if (!asset.url) throw new Error(t('服务端没有返回图片地址。'));
      const normalized = normalizeCoverUrl(asset.url);
      if (!normalized) throw new Error(t('上传结果不能用作封面地址。'));
      setUrl(readableUrl(normalized));
      setTouched(false);
      onChange({ cover_url: normalized, cover_hidden: false });
      toast.push(
        'ok',
        t('封面已更新'),
        demo
          ? t('演示模式的图片保存在浏览器里，导出内容时会一起带走。')
          : t('已使用上传的图片。'),
      );
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
    onChange({ cover_url: '', cover_alt: '', cover_position: 'center', cover_hidden: false });
    toast.push('ok', t('已清除封面'), t('这篇内容会重新使用自动生成的封面。'));
  };

  const status = value.cover_hidden ? (
    <Badge tone="muted">{t('已隐藏')}</Badge>
  ) : cover ? (
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
          <p>{t('随内容保存：列表、首页卡片、订阅源与分享卡都用这张图片。')}</p>
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
            {t('当前账户没有编辑权限，只能查看封面字段。')}
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
          ) : value.cover_hidden ? (
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

        <Field
          label={t('图片描述')}
          htmlFor="pcov-alt"
          aside={`${value.cover_alt.length}/200`}
          hint={t('给屏幕阅读器与社交分享卡用的替代文本；留空则使用标题。')}
        >
          <Input
            id="pcov-alt"
            value={value.cover_alt}
            maxLength={200}
            disabled={disabled}
            placeholder={title || t('描述这张图片')}
            onChange={(event) => onChange({ cover_alt: event.target.value })}
          />
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
                className={value.cover_position === entry.value ? 'is-on' : ''}
                disabled={disabled}
                onClick={() => applyPosition(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <Toggle
          checked={value.cover_hidden}
          disabled={disabled}
          onChange={toggleHidden}
          label={t('隐藏封面')}
          description={t('列表与详情页都不显示封面；设置会保留，随时可以恢复。')}
        />

        <div className="pcov-foot">
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            disabled={disabled || !value.cover_url}
            onClick={clear}
          >
            {t('清除封面')}
          </Button>
          <span className="pcov-hint">
            {preview
              ? t('当前使用自定义图片。')
              : value.cover_hidden
                ? t('当前封面已隐藏。')
                : t('当前使用自动生成的装饰封面。')}
          </span>
        </div>
      </div>
    </div>
  );
}
