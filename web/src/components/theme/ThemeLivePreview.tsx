import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SiteTheme } from '../../types';
import { useT } from '../../lib/i18n';
import {
  clearThemePreview,
  publishThemePreview,
  themePreviewUrl,
} from '../../lib/themePreviewLive';
import { Button } from '../ui';
import { Icon } from '../Icon';

/**
 * 「真实前台」主题预览。
 *
 * 不是画一张示意图，而是把正在用的站点（首页 / 文章列表）放进同源 iframe，用这套
 * 主题重新渲染一遍：配色令牌、版式变体、页面编排、页头页脚都按真实规则生效。
 * 主题只存在于 iframe 文档里（见 `lib/themePreviewLive.ts`），关闭弹窗即还原。
 */

type PreviewPage = 'home' | 'articles';
type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

const PAGES: { key: PreviewPage; path: string; label: string }[] = [
  { key: 'home', path: '/', label: '首页' },
  { key: 'articles', path: '/articles', label: '文章' },
];

const DEVICES: { key: PreviewDevice; width: string; label: string }[] = [
  { key: 'desktop', width: '100%', label: '桌面' },
  { key: 'tablet', width: '768px', label: '平板' },
  { key: 'mobile', width: '390px', label: '手机' },
];

export function ThemeLivePreview({ bundle }: { bundle: SiteTheme }) {
  const t = useT();
  const [page, setPage] = useState<PreviewPage>('home');
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [token, setToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);

  // 主题对象每次渲染都是新的引用（主题库重新拼出来的），交接只跟内容签名走，
  // 否则一次普通重渲染就会把 iframe 重新加载一遍。
  const bundleRef = useRef(bundle);
  bundleRef.current = bundle;
  const signature = useMemo(
    () => `${bundle.id}:${bundle.variant ?? 'classic'}:${JSON.stringify(bundle.theme ?? null)}`,
    [bundle.id, bundle.variant, bundle.theme],
  );

  const publish = useCallback((): string | null => {
    const next = publishThemePreview(bundleRef.current);
    setToken(next);
    setUnavailable(!next);
    setLoading(!!next);
    return next;
  }, []);

  // 打开 / 换主题时发一份交接数据；卸载时清掉，避免旧令牌留在会话里。
  useEffect(() => {
    publish();
    return () => clearThemePreview();
  }, [publish, signature]);

  const path = PAGES.find((item) => item.key === page)?.path ?? '/';
  const src = useMemo(() => themePreviewUrl(token, path), [token, path]);

  // 换页面或刷新时 iframe 会重新加载，加载遮罩跟着复位。
  useEffect(() => {
    setLoading(true);
  }, [nonce, src]);

  const reload = () => {
    publish();
    setNonce((value) => value + 1);
  };

  const deviceWidth = DEVICES.find((item) => item.key === device)?.width ?? '100%';

  return (
    <div className="theme-live">
      <div className="theme-live-bar">
        <div className="theme-live-pages" role="tablist" aria-label={t('预览页面')}>
          {PAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={page === item.key}
              className={`chip${page === item.key ? ' is-active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="theme-live-devices" role="group" aria-label={t('预览宽度')}>
          {DEVICES.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={device === item.key}
              className={`chip${device === item.key ? ' is-active' : ''}`}
              onClick={() => setDevice(item.key)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="theme-live-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={reload} disabled={!token}>
            {t('刷新')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="external"
            disabled={!token}
            onClick={() => token && window.open(src, '_blank', 'noopener')}
          >
            {t('新窗口')}
          </Button>
        </div>
      </div>

      <div className={`theme-live-frame is-${device}`} data-device={device}>
        {unavailable ? (
          <p className="theme-live-empty">
            {t('这个浏览器禁用了会话存储，无法打开真实前台预览；可以先看主题卡片上的样式预览。')}
          </p>
        ) : token ? (
          <>
            <iframe
              key={nonce}
              src={src}
              title={t('真实前台预览')}
              style={{ maxWidth: deviceWidth }}
              onLoad={() => setLoading(false)}
            />
            {loading ? (
              <span className="theme-live-loading">
                <Icon name="refresh" size={16} /> {t('正在加载真实前台…')}
              </span>
            ) : null}
          </>
        ) : (
          <span className="theme-live-loading">
            <Icon name="refresh" size={16} /> {t('正在加载真实前台…')}
          </span>
        )}
      </div>

      <p className="theme-live-hint">
        {t(
          '这里是用站点现有内容真实渲染的前台：配色、版式与页面编排都按这套主题生效，站内链接也能继续点开；关闭弹窗后站点不会改变。',
        )}
      </p>
    </div>
  );
}
