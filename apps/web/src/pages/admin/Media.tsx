import { useRef, useState } from 'react';
import type { Asset } from '../../types';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatBytes } from '../../lib/format';
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
const MIME_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'application/pdf': 'PDF',
  'text/plain': '纯文本',
  'image/svg+xml': 'SVG',
};

const SCAN_LABEL: Record<Asset['scan_status'], string> = {
  pending: '检查中',
  clean: '检查通过',
  rejected: '已拒绝',
  needs_manual_review: '待人工复核',
};

export function MediaPage() {
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [purpose, setPurpose] = useState<'content' | 'avatar' | 'attachment'>('content');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useTitle('媒体库');

  const loaded = useAsync(async () => {
    const items = await backend.listAssets();
    setAssets(items);
    return items;
  }, [backend]);

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
      setError(`不支持的类型：${file.type || '未知'}。允许 PNG、JPEG、WebP、GIF、PDF 与纯文本。`);
      return;
    }
    if (file.size > limit) {
      setError(`文件超过上限（${formatBytes(limit)}）。`);
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const asset = await backend.upload(file, purpose, setProgress);
      setAssets((prev) => [asset, ...prev.filter((item) => item.id !== asset.id)]);
      toast.push(
        asset.scan_status === 'clean' ? 'ok' : 'info',
        asset.scan_status === 'clean' ? '上传完成，检查通过' : `上传完成，状态：${SCAN_LABEL[asset.scan_status]}`,
      );
      if (demo) loaded.reload();
    } catch (err) {
      const text = err instanceof Error ? err.message : '上传失败。';
      setError(text);
      toast.push('error', '上传失败', text);
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
          <h1>媒体库</h1>
          <p>两步上传：先开会话，再传字节，最后由 Rust 安全服务检查。只有 clean 的文件可以被引用。</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="refresh" onClick={loaded.reload}>
            刷新列表
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
        <h3>把文件拖到这里</h3>
        <p>
          允许 {ALLOWED.map((mime) => MIME_LABEL[mime] ?? mime).join(' · ')}，单个文件上限{' '}
          {formatBytes(limit)}
          {demo ? '（演示模式）' : ''}。
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
            选择文件
          </Button>
          <Select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as typeof purpose)}
            style={{ width: 140 }}
            aria-label="用途"
          >
            <option value="content">正文图片</option>
            <option value="avatar">头像</option>
            <option value="attachment">附件</option>
          </Select>
        </div>
        {busy ? (
          <div style={{ maxWidth: 360, margin: '16px auto 0' }}>
            <Progress value={progress} />
            <p className="tiny faint mt-8">上传中 {progress}%</p>
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

      <Callout tone="info" icon="shield" title="前端不信任扩展名或 MIME">
        声明的类型只是线索，服务端会重新检查真实 MIME、文件名与大小。展示地址必须来自后端返回的媒体资源；
        被拒绝的文件按不存在处理。
      </Callout>

      <div className="section-head mt-32">
        <h2 style={{ fontSize: 22 }}>媒体资源</h2>
        <span className="tiny faint">
          {assets.length} 个 · {demo ? '演示数据' : '仅本次会话上传'}
        </span>
      </div>

      {loaded.loading ? (
        <PageLoading label="正在载入媒体" />
      ) : assets.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="image"
            title="还没有媒体"
            body={
              demo
                ? '拖一张图片上来，或者先发布一篇带封面的文章。'
                : '契约 v0.1.0 没有媒体列表端点，因此这里只显示本次会话上传的文件。'
            }
            action={
              <Button variant="secondary" size="sm" icon="upload" onClick={() => inputRef.current?.click()}>
                上传第一个文件
              </Button>
            }
          />
        </div>
      ) : (
        <div className="media-grid mt-20">
          {assets.map((asset) => {
            const src = srcOf(asset);
            const isImage = asset.mime_type.startsWith('image/');
            return (
              <div className="media-card" key={asset.id}>
                <div className="media-thumb">
                  {isImage ? (
                    <img src={src} alt={asset.file_name ?? '媒体'} loading="lazy" />
                  ) : (
                    <Icon name={asset.mime_type === 'application/pdf' ? 'file' : 'code'} size={26} />
                  )}
                </div>
                <div className="media-meta">
                  <strong>{asset.file_name ?? asset.storage_key.split('/').pop()}</strong>
                  <span>
                    {formatBytes(asset.size)} · {MIME_LABEL[asset.mime_type] ?? asset.mime_type}
                  </span>
                  <div className="row gap-6 mt-8" style={{ justifyContent: 'space-between' }}>
                    <Badge tone={asset.scan_status === 'clean' ? 'ok' : asset.scan_status === 'rejected' ? 'danger' : 'warn'}>
                      {SCAN_LABEL[asset.scan_status]}
                    </Badge>
                    <CopyButton
                      value={isImage ? `![${asset.file_name ?? 'image'}](${src})` : `[${asset.file_name ?? 'file'}](${src})`}
                      label="引用"
                    />
                  </div>
                  <span className="tiny faint" style={{ marginTop: 8 }}>
                    {asset.id} · 上传后由服务端生成存储键
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="dash-grid mt-32">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>上传流程</h3>
              <p>两阶段，失败时不产生可引用资源。</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">1 · 打开会话</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">2 · 上传字节</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads/&#123;id&#125;/content
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">3 · 完成检查</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  POST /media/uploads/&#123;id&#125;/complete
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">读取</span>
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
              <h3>存储与限制</h3>
              <p>由服务端环境变量决定。</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">驱动</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_DRIVER=local | s3
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">本地目录</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_DIR=./data/media
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">S3 桶</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  STORAGE_S3_BUCKET
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">单文件上限</span>
                <span className="mini-value">25 MiB</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">安全检查</span>
                <span className="mini-value">不可用时返回 503</span>
              </div>
            </div>
            <p className="tiny faint mt-12">
              {demo
                ? '演示模式把文件读成 Data URL 存在浏览器里，所以上限收窄到 2 MB。'
                : '上传完成后需要等检查通过，才能被文章或头像引用。'}
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
