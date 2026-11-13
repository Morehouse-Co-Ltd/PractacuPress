import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { ApiError } from '../../lib/api';
import { useCustomization } from '../../lib/customize';
import { useSeo } from '../../lib/seo';
import { Callout } from '../../components/ui';
import { FeedProvider, useFeed } from '../../components/blocks/FeedContext';
import { ScreenRenderer } from '../../components/blocks';
import { useT } from '../../lib/i18n';

/**
 * 首页：不再手写任何 markup，全部由「外观 → 页面编排」里的
 * 区块画出来。变体（classic / bento / daylight）写在容器上，样式在 styles.css 里按
 * [data-variant] 作用域切换；组件本身不关心当前是哪套主题。
 */

function FeedError() {
  const t = useT();
  const { error, reload } = useFeed();
  if (!error) return null;
  return (
    <Callout tone="danger" icon="alert" title={t('无法读取内容')}>
      {error instanceof ApiError && error.code === 'unauthenticated'
        ? t('这个站点设置为「登录后浏览」，请先登录。')
        : error instanceof Error
          ? error.message
          : t('请求失败。')}
      <div className="mt-12">
        <Link to="/login" className="btn btn-secondary btn-sm">
          {t('去登录')}
        </Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
          {t('重试')}
        </button>
      </div>
    </Callout>
  );
}

export function HomePage() {
  const { site } = useAuth();
  const { customization } = useCustomization();
  const variant = customization.layout.variant;
  // 首页不写 title：useSeo 会把标题落成站点名，描述取站点简介或 SEO 默认值。
  useSeo({
    path: '/',
    description: site?.description,
    type: 'website',
  });

  return (
    <div className={`shell home-stage home-${variant}`} data-variant={variant}>
      <FeedProvider>
        <FeedError />
        <ScreenRenderer
          layout={customization.home}
          variant={variant}
          scope={{ type: 'home', id: 'home', title: site?.name }}
        />
      </FeedProvider>
    </div>
  );
}
