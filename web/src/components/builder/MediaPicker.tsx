import { useEffect, useState } from 'react';
import type { Asset } from '../../types';
import { useBackend } from '../../lib/backend';
import { useMediaSrc } from '../../lib/assetUrl';
import { useT } from '../../lib/i18n';
import { Button, Modal } from '../ui';

/**
 * 缩略图走带鉴权的 blob：站内 content 素材用 `<img src>` 匿名读会被挡成 404。
 * 取不到 blob 时 hook 回退原地址，浏览器自己再试一次（与改造前一致）。
 */
function PickerThumb({ asset }: { asset: Asset }) {
  const { src } = useMediaSrc(asset.url ?? '');
  return <img src={src || undefined} alt={asset.file_name ?? ''} loading="lazy" />;
}

/**
 * 媒体库选择器。
 *
 * 只列已扫描通过（`scan_status === 'clean'`）的资产：拒绝与待审的资产连管理员
 * 也不该拖进版面。返回值是资产的展示地址，区块里只存这个字符串。
 */
export function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError('');
    backend
      .listAssets()
      .then((items) => {
        if (!alive) return;
        setAssets(
          items.filter(
            (asset) =>
              asset.scan_status === 'clean' &&
              asset.url &&
              asset.mime_type.startsWith('image/'),
          ),
        );
      })
      .catch(() => {
        if (alive) setError(t('读不到媒体库，检查登录状态或后端是否在线。'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, backend, t]);

  return (
    <Modal open={open} title={t('从媒体库选择')} onClose={onClose}>
      {loading ? <p className="field-hint">{t('正在读取媒体库…')}</p> : null}
      {error ? <p className="field-hint">{error}</p> : null}
      {!loading && !error && assets.length === 0 ? (
        <p className="field-hint">{t('媒体库还是空的，先去「媒体」页上传图片。')}</p>
      ) : null}
      <div className="media-picker-grid">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            className="media-picker-item"
            onClick={() => {
              onPick(asset.url ?? '');
              onClose();
            }}
          >
            <PickerThumb asset={asset} />
            <span>{asset.file_name ?? asset.id}</span>
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={onClose}>
        {t('取消')}
      </Button>
    </Modal>
  );
}
