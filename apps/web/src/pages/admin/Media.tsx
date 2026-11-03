import { useRef, useState } from 'react';
import type { Asset, ScanStatus, StorageScope } from '../../types';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  EmptyState,
  PageLoading,
  Progress,
  Select,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../lib/toast';

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];

/** MIME 短标签：两种语言下写法相同，只有 `text/plain` 需要过文案表。 */
const MIME_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'application/pdf': 'PDF',
  'image/svg+xml': 'SVG',
};

export function MediaPage() {
  const t = useT();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [purpose, setPurpose] = useState<'content' | 'avatar' | 'attachment'>('content');
  /** 服务端列表一次取 100 条，状态筛选在浏览器内完成，不再打接口。 */
  const [scan, setScan] = useState<'all' | ScanStatus>('all');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
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
        return t('正文图片');
    }
  };

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

  const visible = scan === 'all' ? assets : assets.filter((asset) => asset.scan_status === scan);

  const limit = demo ? 2 * 1024 * 1024 : 25 * 1024 * 1024;

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
        t('不支持的类型：{type}。允许 PNG、JPEG、WebP、GIF、PDF 与纯文本。', {
          type: file.type || t('未知'),
        }),
      );
      return;
    }
    if (file.size > limit) {
      setError(t('文件超过上限（{limit}）。', { limit: formatBytes(limit) }));
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

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('媒体库')}</h1>
          <p>{t('两步上传：先开会话，再传字节，最后由 Rust 安全服务检查。只有 clean 的文件可以被引用。')}</p>
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
          {t('允许 {types}，单个文件上限 {limit}{demo}。', {
            types: ALLOWED.map(mimeLabel).join(' · '),
            limit: formatBytes(limit),
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
            <option value="content">{t('正文图片')}</option>
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
          {scan === 'all' ? '' : ` · ${t('共 {total} 个', { total: assets.length })}`}
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
              <Button variant="secondary" size="sm" onClick={() => setScan('all')}>
                {t('查看全部')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="media-grid mt-20">
          {visible.map((asset) => {
            const src = srcOf(asset);
            const isImage = asset.mime_type.startsWith('image/');
            return (
              <div className="media-card" key={asset.id}>
                <div className="media-thumb">
                  {isImage ? (
                    <img src={src} alt={asset.file_name ?? t('媒体')} loading="lazy" />
                  ) : (
                    <Icon name={asset.mime_type === 'application/pdf' ? 'file' : 'code'} size={26} />
                  )}
                </div>
                <div className="media-meta">
                  <strong>{asset.file_name ?? asset.storage_key.split('/').pop()}</strong>
                  <span>
                    {formatBytes(asset.size)} · {mimeLabel(asset.mime_type)}
                    {asset.purpose ? ` · ${purposeLabel(asset.purpose)}` : ''}
                  </span>
                  <div className="row gap-6 mt-8" style={{ justifyContent: 'space-between' }}>
                    <Badge tone={asset.scan_status === 'clean' ? 'ok' : asset.scan_status === 'rejected' ? 'danger' : 'warn'}>
                      {scanLabel(asset.scan_status)}
                    </Badge>
                    <CopyButton
                      value={isImage ? `![${asset.file_name ?? 'image'}](${src})` : `[${asset.file_name ?? 'file'}](${src})`}
                      label={t('引用')}
                    />
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

      <div className="dash-grid mt-32">
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
                <span className="mini-label">{t('单文件上限')}</span>
                <span className="mini-value">25 MiB</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('安全检查')}</span>
                <span className="mini-value">{t('不可用时返回 503')}</span>
              </div>
            </div>
            <p className="tiny faint mt-12">
              {demo
                ? t('演示模式把文件读成 Data URL 存在浏览器里，所以上限收窄到 2 MB。')
                : t('上传完成后需要等检查通过，才能被文章或头像引用。')}
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
