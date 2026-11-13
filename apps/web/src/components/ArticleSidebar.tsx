import { Link } from 'react-router-dom';
import type { Comment, Content, TaxonomyTerm } from '../types';
import { Avatar } from './ui';
import { Icon } from './Icon';
import { formatDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { contentPath } from '../pages/site/readExperience';

/**
 * 文章页侧边栏（FSD A-05）。
 *
 * 作者卡、热门 Top5、最新评论 5 条、分类导航。移动端整块隐藏（CSS），
 * 保证正文有足够宽度。
 *
 * 热门 Top5 用服务端的热门榜（FSD A-16）：按单篇阅读量加时间衰减排序，不再是
 * 「近期内容」的替代品。没有阅读数据时服务端按发布时间倒序，所以空站点依然有内容。
 */
export function ArticleSidebar({
  item,
  categories,
  categoryCounts,
  popular,
  comments,
}: {
  item: Content;
  categories: TaxonomyTerm[];
  categoryCounts: Record<string, number>;
  /** 已按热度排好序的同类内容，第一项最热；当前文章由调用方剔除。 */
  popular: Content[];
  comments: Comment[];
}) {
  const t = useT();
  const top = popular.filter((entry) => entry.id !== item.id).slice(0, 5);
  const latestComments = comments
    .filter((comment) => comment.status === 'visible')
    .slice(0, 5);
  const tags = (item.tags ?? []).slice(0, 8);

  return (
    <aside className="article-side" aria-label={t('文章侧栏')}>
      <div className="side-inner">
        {item.author_id ? (
          <section className="side-block side-author">
            <Avatar name={item.author_name ?? t('编辑部')} size={44} />
            <div className="side-author-main">
              <strong>{item.author_name ?? t('编辑部')}</strong>
              <span>{t('写作者')}</span>
            </div>
            <Link to={`/u/${item.author_id}`} className="side-author-link">
              {t('作者主页')} <Icon name="arrow-right" size={12} />
            </Link>
          </section>
        ) : null}

        {categories.length ? (
          <nav className="side-block" aria-label={t('分类导航')}>
            <h3>{t('分类导航')}</h3>
            <ul className="side-taxonomy">
              {categories.map((term) => (
                <li key={term.id}>
                  <Link to={`/category/${encodeURIComponent(term.slug)}`}>
                    <span
                      className="side-taxonomy-dot"
                      style={{ background: term.color || 'var(--accent)' }}
                      aria-hidden
                    />
                    <span className="side-taxonomy-name">{term.name}</span>
                    <em>{categoryCounts[term.id] ?? 0}</em>
                  </Link>
                </li>
              ))}
            </ul>
            <Link to="/categories" className="side-more">
              {t('全部分类')} <Icon name="arrow-right" size={12} />
            </Link>
          </nav>
        ) : null}

        {top.length ? (
          <nav className="side-block" aria-label={t('热门内容')}>
            <h3>{t('热门 Top5')}</h3>
            <div className="side-list">
              {top.map((entry, index) => {
                const views = entry.view_count ?? 0;
                return (
                  <Link className="side-story" to={contentPath(entry)} key={entry.id}>
                    <strong>
                      <span className="side-story-index">{String(index + 1).padStart(2, '0')}</span>
                      {entry.title}
                    </strong>
                    <span>
                      {views > 0
                        ? t('{count} 次阅读', { count: views })
                        : formatDate(entry.published_at ?? entry.created_at)}
                    </span>
                  </Link>
                );
              })}
            </div>
          </nav>
        ) : null}

        {tags.length ? (
          <div className="side-block">
            <h3>{t('标签')}</h3>
            <div className="side-tags">
              {tags.map((tag) => (
                <Link key={tag} to={`/tag/${encodeURIComponent(tag)}`} className="chip">
                  #{tag}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        {latestComments.length ? (
          <div className="side-block">
            <h3>{t('最新评论')}</h3>
            <ul className="side-comments">
              {latestComments.map((comment) => (
                <li key={comment.id}>
                  <a href="#comments">
                    <strong>{comment.author_name ?? t('读者')}</strong>
                    <span>{comment.body.length > 48 ? `${comment.body.slice(0, 48)}…` : comment.body}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
