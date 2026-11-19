import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { ApiError, isBackendOffline } from '../../lib/api';
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
  const unauthenticated = error instanceof ApiError && error.code === 'unauthenticated';
  // 后端连不上（fetch 失败时 status = 0）不是登录问题：标题直接说连接失败，
  // 也不要给出「去登录」——登录页同样连不上后端，只会把读者带进死路。
  const offline = isBackendOffline(error);
  return (
    <Callout tone="danger" icon="alert" title={offline ? t('无法连接 API') : t('无法读取内容')}>
      {unauthenticated
        ? t('这个站点设置为「登录后浏览」，请先登录。')
        : error instanceof Error
          ? error.message
          : t('请求失败。')}
      <div className="mt-12 row gap-8">
        {unauthenticated ? (
          <Link to="/login" className="btn btn-secondary btn-sm">
            {t('去登录')}
          </Link>
        ) : null}
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
