import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { RoleGate } from '../../components/Guards';
import { AccessPage } from './Access';
import { DomainsPage } from './Domains';

/**
 * 站点设置 · 访问与域名。
 *
 * 访问限制与域名绑定原本是两个独立页面，这里合成一个界面：先决定谁能访问，
 * 再决定从哪些域名访问，保存逻辑仍各自独立。
 */
export function AccessDomainsPage() {
  const t = useT();
  useTitle(t('访问与域名'));
  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('访问与域名')}</h1>
          <p>
            {t(
              '限制页面切换、请求与同浏览器并发；同时设置站点主域名、别名、SSL 证书、CORS 与可信代理。没有主域名时，生产环境只允许公网 IP 直接访问。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => window.open('/', '_blank')}
          >
            {t('查看前台')}
          </button>
        </div>
      </div>

      <AccessPage embedded />
      <DomainsPage embedded />
    </RoleGate>
  );
}
