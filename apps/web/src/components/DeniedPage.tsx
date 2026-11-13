import { Link } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { ROLE_LABEL } from '../lib/format';
import { useT } from '../lib/i18n';
import { Forbidden } from './Guards';
import { Icon } from './Icon';

/**
 * 已登录、但没有权限时的整页提示。
 *
 * 后台与写作台共用：页头只保留品牌与「返回站点」，不出现后台导航，也不提供任何
 * 通往管理页面的入口 —— 拒绝访问时才最不该顺手把后台地图递过去。
 */
export function DeniedPage({ need, badge }: { need: string; badge: string }) {
  const t = useT();
  const { me, site } = useAuth();
  return (
    <div className="site">
      <header className="site-header">
        <div className="shell header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">{Array.from(site?.name ?? 'P')[0]}</span>
            <span>
              <span className="brand-text">{site?.name ?? 'Practacu Press'}</span>
              <span className="brand-sub">{badge}</span>
            </span>
          </Link>
          <div className="header-actions">
            <span className="chip">{me ? ROLE_LABEL[me.role] : t('访客')}</span>
            <Link to="/" className="btn btn-secondary btn-sm">
              <Icon name="arrow-left" size={14} /> {t('返回站点')}
            </Link>
          </div>
        </div>
      </header>
      <main className="shell shell-narrow">
        <div style={{ paddingTop: 48 }}>
          <Forbidden need={need} />
        </div>
      </main>
    </div>
  );
}
