import { useRef, useState } from 'react';
import type { Asset, ScanStatus, StorageScope } from '../../types';
import { useBackend, isDemo } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useMediaSrc } from '../../lib/assetUrl';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/usePermissions';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  EmptyState,
  Modal,
  PageLoading,
  Progress,
  Select,
  Skeleton,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../lib/toast';

const ALLOWED = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/webm',
];

/** MIME 短标签：两种语言下写法相同，只有 `text/plain` 需要过文案表。 */
const MIME_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'application/pdf': 'PDF',
  'image/svg+xml': 'SVG',
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
};

type MediaKind = 'all' | 'image' | 'video' | 'document';

/** 类型筛选：视频单独一类，文档是既不是图片也不是视频的附件。 */
function mediaKindOf(asset: Asset): Exclude<MediaKind, 'all'> {
  if (asset.mime_type.startsWith('image/')) return 'image';
  if (asset.mime_type.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * 素材的展示名。
 *
 * 服务端从 Beta 1.2 起会返回 `file_name`，但旧数据、外部导入或只有存储键的素材仍然
 * 可能没有名字：此时退回存储键的最后一段，再不行用素材 id，绝不显示空白。
 */
function assetName(asset: Asset): string {
  const named = asset.file_name?.trim();
  if (named) return named;
  const key = (asset.storage_key ?? '').split('/').filter(Boolean).pop()?.trim();
  return key || (asset.storage_key ?? '').trim() || asset.id;
}

/** 引用片段里的替代文字：去掉会在 Markdown 里破句的方括号。 */
function markdownAlt(asset: Asset): string {
  return assetName(asset).replace(/[[\]]/g, ' ').trim() || 'image';
}

/**
 * 媒体缩略图。
 *
 * 站内媒体读取对 content 素材要鉴权，而 `<img src>` 带不上 Authorization，所以
 * 统一交给 useMediaSrc 换成 blob: 地址；取不到时退回图标，不留空白框。
 */
function MediaThumb({ asset, src }: { asset: Asset; src: string }) {
  const { src: resolved, failed } = useMediaSrc(src);
  const kind = mediaKindOf(asset);
  if (failed || kind !== 'image') {
    return <Icon name={kind === 'video' ? 'video' : kind === 'document' ? 'file' : 'code'} size={26} />;
  }
  return resolved ? (
    <img src={resolved} alt={assetName(asset)} loading="lazy" />
  ) : null;
}

/**
 * 预览弹层里的媒体本体。
 *
 * 和缩略图一样走 useMediaSrc：真实后端的媒体端点要鉴权，直接把地址交给 `<img>`
 * 只会拿到 404。取不到字节时给一句可操作的说明，而不是留一块空白。
 */
function MediaPreviewBody({ asset, src }: { asset: Asset; src: string }) {
  const t = useT();
  const { src: resolved, failed } = useMediaSrc(src);
  if (failed) {
    return (
      <p className="small muted">
        {t('浏览器无法直接预览这个文件，可以复制「引用」里的地址打开。')}
      </p>
    );
  }
  if (!resolved) return <Skeleton lines={3} />;
  if (asset.mime_type.startsWith('video/')) {
    return (
      <video
        src={resolved}
        controls
        playsInline
        preload="metadata"
        style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto', borderRadius: 10 }}
      />
    );
  }
  return (
    <img
      src={resolved}
      alt={assetName(asset)}
      style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '0 auto', borderRadius: 10 }}
    />
  );
}

export function MediaPage() {
  const t = useT();
  const backend = useBackend();
  const { site } = useAuth();
  const demo = isDemo(backend);
  const toast = useToast();
  const { can } = usePermissions();
  /**
   * 删除是不可撤销的站点级操作：能力 id 与储存策略、访问与域名页一致，普通成员
   * 即使能进后台也看不到删除入口。
   */
  const canDelete = can('manage_site');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [purpose, setPurpose] = useState<'content' | 'avatar' | 'attachment'>('content');
  /** 服务端列表一次取 100 条，状态筛选在浏览器内完成，不再打接口。 */
  const [scan, setScan] = useState<'all' | ScanStatus>('all');
  const [kind, setKind] = useState<MediaKind>('all');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  /** 待二次确认删除的素材；null 表示确认弹窗关闭。 */
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  /** 预览（详情）弹层里的素材；删除成功后如果指向同一份素材要一并关闭。 */
  const [preview, setPreview] = useState<Asset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useTitle(t('媒体库'));

  /** MIME 短标签；与 MIME_LABEL 合并成一处，避免调用点重复判断。 */
  const mimeLabel = (mime: string): string =>
    mime === 'text/plain' ? t('纯文本') : (MIME_LABEL[mime] ?? mime);

  /** 上传安全检查的状态文案。 */
  const scanLabel = (status: Asset['scan_status']): string => {
    switch (status) {
      case 'clean':
        return t('检查通过');
      case 'rejected':
        return t('已拒绝');
      case 'needs_manual_review':
        return t('待人工复核');
      default:
        return t('检查中');
    }
  };

  /** 上传用途的中文标签；契约里 `purpose` 是可选的。 */
  const purposeLabel = (value: StorageScope): string => {
    switch (value) {
      case 'avatar':
        return t('头像');
      case 'attachment':
        return t('附件');
      case 'site':
        return t('站点素材');
      default:
        return t('正文媒体');
    }
  };

  const kindFilters: Array<{ key: MediaKind; label: string }> = [
    { key: 'all', label: t('全部类型') },
    { key: 'image', label: t('图片') },
    { key: 'video', label: t('视频') },
    { key: 'document', label: t('文档') },
  ];

  const scanFilters: Array<{ key: 'all' | ScanStatus; label: string }> = [
    { key: 'all', label: t('全部') },
    { key: 'clean', label: scanLabel('clean') },
    { key: 'needs_manual_review', label: scanLabel('needs_manual_review') },
    { key: 'pending', label: scanLabel('pending') },
    { key: 'rejected', label: scanLabel('rejected') },
  ];

  const loaded = useAsync(async () => {
    const items = await backend.listAssets();
    setAssets(items);
    return items;
  }, [backend]);

  const visible = assets.filter(
    (asset) =>
      (scan === 'all' || asset.scan_status === scan) &&
      (kind === 'all' || mediaKindOf(asset) === kind),
  );

  // 单次上传上限由「储存设置」里的按用户额度在服务端执行；这里不再硬编码。
  const siteQuota = (() => {
    const raw = site?.media_quota_bytes;
    if (raw === null || raw === undefined) return null;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(value) && value >= 0 ? value : null;
  })();
  const quotaLabel =
    siteQuota === null
      ? t('跟随部署默认')
      : siteQuota === 0
        ? t('无限额度')
        : formatBytes(siteQuota);

  const srcOf = (asset: Asset): string => {
    if (asset.url) return asset.url;
    return `${backend.origin || window.location.origin}/api/v1/media/${asset.id}`;
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    setError('');
    if (!ALLOWED.includes(file.type)) {
      setError(
        t('不支持的类型：{type}。允许 PNG、JPEG、WebP、GIF、PDF、纯文本、MP4 与 WebM。', {
          type: file.type || t('未知'),
        }),
      );
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const asset = await backend.upload(file, purpose, setProgress);
      // 上传是写操作，客户端会清空 GET 缓存，所以重拉拿到的是服务端新数据。
      loaded.reload();
      toast.push(
        asset.scan_status === 'clean' ? 'ok' : 'info',
        asset.scan_status === 'clean'
          ? t('上传完成，检查通过')
          : t('上传完成，状态：{status}', { status: scanLabel(asset.scan_status) }),
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : t('上传失败。');
      setError(text);
      toast.push('error', t('上传失败'), text);
    } finally {
      setBusy(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  /** 引用片段：图片用 `![]()`，其它类型用普通链接。 */
  const markdownOf = (asset: Asset): string => {
    const src = srcOf(asset);
    return asset.mime_type.startsWith('image/')
      ? `![${markdownAlt(asset)}](${src})`
      : `[${markdownAlt(asset)}](${src})`;
  };

  /** 打开删除确认层；预览层先留着，删除成功时一并关掉。 */
  const askDelete = (asset: Asset) => {
    setDeleteError('');
    setDeleteTarget(asset);
  };

  const closeDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError('');
  };

  /**
   * 删除一份素材。
   *
   * 服务端返回 204；素材仍被文章、页面或头像引用时抛 ApiError，message 就是原因
   * （例如「仍被引用」），这里原样展示，不吞成一句笼统的「删除失败」。
   */
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await backend.deleteAsset(target.id);
      // 列表是唯一数据源：本地移除即可，不必再拉一次接口。
      setAssets((prev) => prev.filter((asset) => asset.id !== target.id));
      // 预览层还指着这份素材时一起关掉，别留下一个打不开的地址。
      setPreview((current) => (current?.id === target.id ? null : current));
      setDeleteTarget(null);
      toast.push('ok', t('已删除素材'), assetName(target));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('删除失败。');
      setDeleteError(message);
      toast.push('error', t('删除失败'), message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('媒体库')}</h1>
          <p>{t('两步上传：先开会话，再传字节，最后由 内置安全清洗检查。只有 clean 的文件可以被引用。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="refresh" loading={loaded.loading} onClick={loaded.reload}>
            {t('刷新列表')}
          </Button>
        </div>
      </div>

      <div
        className={`media-drop${over ? ' is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <h3>{t('把文件拖到这里')}</h3>
        <p>
          {t('允许 {types}，站点媒体额度 {quota}{demo}。', {
            types: ALLOWED.map(mimeLabel).join(' · '),
            quota: quotaLabel,
            demo: demo ? t('（演示模式）') : '',
          })}
        </p>
        <div className="row gap-8" style={{ justifyContent: 'center' }}>
          <input
            ref={inputRef}
            type="file"
            hidden
            accept={ALLOWED.join(',')}
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button variant="secondary" icon="upload" loading={busy} onClick={() => inputRef.current?.click()}>
            {t('选择文件')}
          </Button>
          <Select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as typeof purpose)}
            style={{ width: 140 }}
            aria-label={t('用途')}
          >
            <option value="content">{t('正文媒体')}</option>
            <option value="avatar">{t('头像')}</option>
            <option value="attachment">{t('附件')}</option>
          </Select>
        </div>
        {busy ? (
          <div style={{ maxWidth: 360, margin: '16px auto 0' }}>
            <Progress value={progress} />
            <p className="tiny faint mt-8">{t('上传中 {progress}%', { progress })}</p>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mb-20">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      <Callout tone="info" icon="shield" title={t('前端不信任扩展名或 MIME')}>
        {t(
          '声明的类型只是线索，服务端会重新检查真实 MIME、文件名与大小。展示地址必须来自后端返回的媒体资源；被拒绝的文件按不存在处理。',
        )}
      </Callout>

      {loaded.error ? (
        <div className="mb-20">
          <Callout tone="danger" icon="alert" title={t('无法读取媒体列表')}>
            {loaded.error instanceof Error ? loaded.error.message : t('请求失败。')}
          </Callout>
        </div>
      ) : null}

      <div className="section-head mt-32">
        <h2 style={{ fontSize: 22 }}>{t('媒体资源')}</h2>
        <span className="tiny faint">
          {t('{count} 个', { count: visible.length })}
          {scan === 'all' && kind === 'all' ? '' : ` · ${t('共 {total} 个', { total: assets.length })}`}
          {demo ? ` · ${t('演示数据')}` : ''}
        </span>
      </div>

      {assets.length > 0 ? (
        <div className="row gap-6 mt-16" role="group" aria-label={t('按检查状态筛选')}>
          {scanFilters.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`pill${scan === entry.key ? ' is-on' : ''}`}
              onClick={() => setScan(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      {assets.length > 0 ? (
        <div className="row gap-6 mt-8" role="group" aria-label={t('按类型筛选')}>
          {kindFilters.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`pill${kind === entry.key ? ' is-on' : ''}`}
              onClick={() => setKind(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      {loaded.loading && assets.length === 0 ? (
        <PageLoading label={t('正在载入媒体')} />
      ) : assets.length === 0 ? (
        loaded.error ? null : (
          <div className="mt-20">
            <EmptyState
              icon="image"
              title={t('还没有媒体')}
              body={
                demo
                  ? t('拖一张图片上来，或者先发布一篇带封面的文章。')
                  : t('上传的文件会出现在这里；被拒绝的文件按不存在处理。')
              }
              action={
                <Button variant="secondary" size="sm" icon="upload" onClick={() => inputRef.current?.click()}>
                  {t('上传第一个文件')}
                </Button>
              }
            />
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="filter"
            title={t('没有符合筛选条件的媒体')}
            body={t('换个状态看看，或者回到全部。')}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setScan('all');
                  setKind('all');
                }}
              >
                {t('查看全部')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="media-grid mt-20">
          {visible.map((asset) => {
            const src = srcOf(asset);
            const playable = asset.mime_type.startsWith('image/') || asset.mime_type.startsWith('video/');
            return (
              <div className="media-card" key={asset.id}>
                <div className="media-thumb">
                  {playable ? (
                    <button
                      type="button"
                      onClick={() => setPreview(asset)}
                      aria-label={t('预览「{name}」', { name: assetName(asset) })}
                      title={t('预览')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: '100%',
                        padding: 0,
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'zoom-in',
                      }}
                    >
                      <MediaThumb asset={asset} src={src} />
                    </button>
                  ) : (
                    <Icon
                      name={asset.mime_type.startsWith('video/') ? 'video' : asset.mime_type === 'application/pdf' ? 'file' : 'code'}
                      size={26}
                    />
                  )}
                </div>
                <div className="media-meta">
                  <strong title={assetName(asset)}>{assetName(asset)}</strong>
                  <span>
                    {formatBytes(asset.size)} · {mimeLabel(asset.mime_type)}
                    {asset.purpose ? ` · ${purposeLabel(asset.purpose)}` : ''}
                  </span>
                  <div className="row gap-6 mt-8" style={{ justifyContent: 'space-between' }}>
                    <Badge tone={asset.scan_status === 'clean' ? 'ok' : asset.scan_status === 'rejected' ? 'danger' : 'warn'}>
                      {scanLabel(asset.scan_status)}
                    </Badge>
                    <div className="row gap-6">
                      <CopyButton value={markdownOf(asset)} label={t('引用')} />
                      {canDelete ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          title={t('删除素材')}
                          aria-label={t('删除素材「{name}」', { name: assetName(asset) })}
                          onClick={() => askDelete(asset)}
                        />
                      ) : null}
                    </div>
                  </div>
                  <span className="tiny faint" style={{ marginTop: 8 }}>
                    {asset.id}
                    {asset.created_at
                      ? ` · ${formatDateTime(asset.created_at)}`
                      : ` · ${t('上传后由服务端生成存储键')}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {demo ? null : (
        <p className="tiny faint mt-16">
          {t('列表最多载入 100 条（按上传时间倒序），状态筛选在浏览器内完成。')}
        </p>
      )}

      <div className="dash-grid media-info-grid mt-32">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('上传流程')}</h3>
              <p>{t('两阶段，失败时不产生可引用资源。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('1 · 打开会话')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('2 · 上传字节')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads/&#123;id&#125;/content
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('3 · 完成检查')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads/&#123;id&#125;/complete
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('列表')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  GET /media
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('读取')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  GET /media/&#123;assetID&#125;
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('存储与限制')}</h3>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('驱动')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_DRIVER=local | s3
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('本地目录')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_DIR=./data/media
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('S3 桶')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_S3_BUCKET
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('站点媒体额度')}</span>
                <span className="mini-value">{quotaLabel}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('单次上传上限')}</span>
                <span className="mini-value">{t('见储存设置')}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('安全检查')}</span>
                <span className="mini-value">{t('不可用时返回 503')}</span>
              </div>
            </div>
            <p className="tiny faint mt-12">
              {demo
                ? t('演示模式把文件读成 Data URL 存在浏览器里，刷新页面后会丢失。')
                : t('上传完成后需要等检查通过，才能被文章或头像引用。')}
            </p>
          </div>
        </section>
      </div>

      {/* 预览（详情）层：删除成功且指向同一份素材时会一起关闭。 */}
      <Modal
        open={!!preview}
        title={preview ? assetName(preview) : t('预览素材')}
        description={
          preview
            ? `${formatBytes(preview.size)} · ${mimeLabel(preview.mime_type)}${
                preview.purpose ? ` · ${purposeLabel(preview.purpose)}` : ''
              }`
            : undefined
        }
        onClose={() => setPreview(null)}
        width={720}
        footer={
          preview ? (
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {t('关闭')}
              </Button>
              <CopyButton value={markdownOf(preview)} label={t('引用')} />
              {canDelete ? (
                <Button variant="danger" icon="trash" onClick={() => askDelete(preview)}>
                  {t('删除素材')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {preview ? (
          <div className="form-stack">
            <MediaPreviewBody asset={preview} src={srcOf(preview)} />
            <p className="tiny faint mono">{preview.id}</p>
          </div>
        ) : null}
      </Modal>

      {/* 二次确认：删除不可撤销，被引用的素材会被服务端拒绝。 */}
      <Modal
        open={!!deleteTarget}
        title={t('删除素材')}
        description={deleteTarget ? assetName(deleteTarget) : undefined}
        onClose={closeDelete}
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete} disabled={deleting}>
              {t('取消')}
            </Button>
            <Button variant="danger" icon="trash" loading={deleting} onClick={() => void confirmDelete()}>
              {t('删除')}
            </Button>
          </>
        }
      >
        {deleteTarget ? (
          <div className="form-stack">
            <Callout tone="warn" icon="alert" title={t('删除后不可恢复')}>
              {t('被内容引用的素材不能删除；先解除引用再试。')}
            </Callout>
            <p className="tiny faint">{t('删除会同时清掉所有尺寸变体，无法撤销。')}</p>
            {deleteError ? (
              <Callout tone="danger" icon="alert" title={t('删除失败')}>
                {deleteError}
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
