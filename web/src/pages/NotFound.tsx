import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { APP_VERSION_LABEL } from '../lib/appVersion';
import { useSeo } from '../lib/seo';
import { useT } from '../lib/i18n';

export function NotFoundPage() {
  const t = useT();
  useSeo({ title: t('页面不存在'), description: t('这个地址没有对应的内容。'), noindex: true });
  return (
    <div className="shell">
      <div style={{ padding: '72px 0 40px', maxWidth: 560 }}>
        <p className="eyebrow">404</p>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 42, fontWeight: 400, letterSpacing: '-0.02em' }}>
          {t('这间屋子没有门牌。')}
        </h1>
        <p className="muted mt-16" style={{ lineHeight: 1.85 }}>
          {t('页面可能已经移动，或者链接里的站点、内容不存在。你可以回首页，或者去文章归档里翻一翻。')}
        </p>
        <div className="row gap-8 mt-24">
          <Link to="/" className="btn btn-primary">
            {t('回到首页')}
          </Link>
          <Link to="/articles" className="btn btn-secondary">
            {t('浏览文章')}
          </Link>
        </div>
        <p className="tiny faint mt-32">
          <Icon name="info" size={12} /> {t('Practacu Press · 契约 {version}', { version: APP_VERSION_LABEL })}
        </p>
      </div>
    </div>
  );
}
