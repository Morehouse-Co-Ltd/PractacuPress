import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { isAuthPath, isPreviewFrame } from '../lib/access';
import { boundDomains, domainAllowed, readDomains } from '../lib/domains';
import { useT } from '../lib/i18n';

/**
 * 域名白名单的浏览器端提示页。
 *
 * 它不是安全边界：真正的域名归属由 DNS 与反向代理 `server_name` 决定。这里只在
 * 当前 host 没有列进白名单时挡住前台页面，防止把站点内容显示在一个未配置证书或
 * 不该出现的域名上；管理员始终可以从「进入管理后台」回到设置页。
 */
export function DomainGuard({ children }: { children: ReactNode }) {
  const t = useT();
  const { config, site } = useAuth();
  const location = useLocation();
  const domains = readDomains(config);
  const adminPath = (config.admin_path?.trim() || '/admin').replace(/\/+$/, '') || '/admin';
  const pathname = location.pathname;

  const isAdmin =
    isAuthPath(pathname) ||
    pathname === '/setup' ||
    pathname.startsWith('/setup/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === adminPath ||
    pathname.startsWith(`${adminPath}/`);

  if (!domains.enabled || isAdmin || isPreviewFrame()) return <>{children}</>;

  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  const primary = site?.domain || domains.primary;
  if (domainAllowed(host, domains, primary)) return <>{children}</>;

  const allowed = boundDomains(domains, primary);
  return (
    <div className="domain-block-screen">
      <div className="domain-block-card">
        <p className="eyebrow">Domain not bound</p>
        <h1>{t('这个域名还没有绑定到本站')}</h1>
        <p className="domain-block-lede">
          {t('当前访问的域名是')} <code className="mono">{host || t('未知主机')}</code>
          {t('。如果这是你的站点，请把域名加入白名单，并在 DNS 与反向代理里完成绑定。')}
        </p>
        <div className="domain-block-list">
          <p className="field-label">{t('已允许的域名')}</p>
          {allowed.length ? (
            <ul>
              {allowed.map((item) => (
                <li key={item}>
                  <code className="mono">{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small faint">{t('白名单为空。')}</p>
          )}
        </div>
        <div className="row gap-8 domain-block-actions">
          <Link to={adminPath} className="btn btn-primary btn-sm">
            {t('进入管理后台')}
          </Link>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => window.location.reload()}
          >
            {t('重新检查')}
          </button>
        </div>
        <p className="tiny faint domain-block-note">
          {t('提示：浏览器端白名单只负责展示提示；真正阻止未绑定域名访问的是 DNS 与反向代理。')}
        </p>
      </div>
    </div>
  );
}
