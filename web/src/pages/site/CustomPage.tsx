import { Link, useParams } from 'react-router-dom';
import { useCustomization } from '../../lib/customize';
import { useAuth } from '../../lib/session';
import { formatDate } from '../../lib/format';
import { Badge } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NotFoundPage } from '../NotFound';
import { FeedProvider } from '../../components/blocks/FeedContext';
import { ScreenRenderer } from '../../components/blocks';
import { screenHasBlocks } from '../../lib/blocks';
import { useSeo } from '../../lib/seo';
import { useT } from '../../lib/i18n';

/** 自定义页面：路径由安装配置里的 pages 决定，没有对应后端端点。 */
export function CustomPage({ pageSlug }: { pageSlug?: string } = {}) {
  const t = useT();
  const { slug = '' } = useParams();
  const resolvedSlug = pageSlug ?? slug;
  const { customization } = useCustomization();
  const { me } = useAuth();
  const page = customization.pages.find((entry) => entry.slug === resolvedSlug);
  useSeo({
    title: page?.title ?? t('页面不存在'),
    path: `/${resolvedSlug}`,
    description: page?.summary,
    noindex: !page || page.status !== 'published',
    jsonLd: page
      ? [{ '@type': 'WebPage', name: page.title, description: page.summary || undefined }]
      : [],
  });

  if (!page) return <NotFoundPage />;

  const canSeeDraft = me?.role === 'site_admin' || me?.role === 'platform_admin';
  if (page.status !== 'published' && !canSeeDraft) return <NotFoundPage />;

  const pageLayout = page.layout ?? { blocks: [] };
  const variant = customization.layout.variant;

  return (
    <div className={`shell${variant === 'bento' ? ' page-bento' : ''}`} data-variant={variant}>
      <article className="page-hero">
        <p className="eyebrow">Page</p>
        <h1>{page.title}</h1>
        {page.summary ? <p className="page-summary">{page.summary}</p> : null}
        <p className="page-meta row gap-8" style={{ flexWrap: 'wrap' }}>
          <span>{t('更新于 {date}', { date: formatDate(page.updated_at) })}</span>
          {page.status !== 'published' ? <Badge tone="warn">{t('草稿预览')}</Badge> : null}
        </p>
      </article>

      {screenHasBlocks(pageLayout) ? (
        <FeedProvider>
          <ScreenRenderer
            layout={pageLayout}
            variant={variant}
            scope={{ type: 'page', id: page.id, title: page.title }}
          />
        </FeedProvider>
      ) : null}

      <div className="page-body-wrap mt-32" style={{ paddingBottom: 8 }}>
        <Link to="/" className="back-link">
          <Icon name="arrow-left" size={13} /> {t('回到首页')}
        </Link>
      </div>
    </div>
  );
}
