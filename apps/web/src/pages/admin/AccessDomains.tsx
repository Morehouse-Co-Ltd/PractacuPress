import { useSearchParams } from 'react-router-dom';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { RoleGate } from '../../components/Guards';
import { AccessPortPanel } from '../../components/AccessPort';
import { AccessPage } from './Access';
import { DomainsPage } from './Domains';

type AccessTab = 'access' | 'domains' | 'port';

/**
 * 站点设置 · 访问与域名。
 *
 * 访问限制与域名绑定原本是两个独立页面，后来被拼成一条很长的表单；
 * 访问端口又藏在运行时接口里没有入口。这里用三个可深链的 Tab 收在一起：
 * `?tab=access`（默认）、`?tab=domains` 与 `?tab=port`，
 * 每块内容各自保存，互不影响。
 */
export function AccessDomainsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: AccessTab = rawTab === 'domains' || rawTab === 'port' ? rawTab : 'access';
  useTitle(t('访问与域名'));

  const select = (next: AccessTab) => {
    const copy = new URLSearchParams(params);
    if (next === 'access') copy.delete('tab');
    else copy.set('tab', next);
    setParams(copy, { replace: true });
  };

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

      <div className="admin-tabs" role="tablist" aria-label={t('访问与域名')}>
        <button
          type="button"
          role="tab"
          id="access-tab"
          aria-controls="access-panel"
          aria-selected={tab === 'access'}
          className={`admin-tab${tab === 'access' ? ' is-active' : ''}`}
          onClick={() => select('access')}
        >
          {t('访问限制')}
        </button>
        <button
          type="button"
          role="tab"
          id="domains-tab"
          aria-controls="domains-panel"
          aria-selected={tab === 'domains'}
          className={`admin-tab${tab === 'domains' ? ' is-active' : ''}`}
          onClick={() => select('domains')}
        >
          {t('访问与域名')}
        </button>
        <button
          type="button"
          role="tab"
          id="port-tab"
          aria-controls="port-panel"
          aria-selected={tab === 'port'}
          className={`admin-tab${tab === 'port' ? ' is-active' : ''}`}
          onClick={() => select('port')}
        >
          {t('访问端口')}
        </button>
      </div>

      <div
        id={tab === 'access' ? 'access-panel' : tab === 'domains' ? 'domains-panel' : 'port-panel'}
        role="tabpanel"
        aria-labelledby={
          tab === 'access' ? 'access-tab' : tab === 'domains' ? 'domains-tab' : 'port-tab'
        }
      >
        {tab === 'access' ? (
          <AccessPage embedded />
        ) : tab === 'domains' ? (
          <DomainsPage embedded />
        ) : (
          <AccessPortPanel />
        )}
      </div>
    </RoleGate>
  );
}
