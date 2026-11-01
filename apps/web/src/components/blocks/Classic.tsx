import { Fragment, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { BlockInstance, Content } from '../../types';
import { useAuth } from '../../lib/session';
import { useFeed } from './FeedContext';
import { PUBLISH_LABEL, VISIBILITY_LABEL, formatDate, readingTime, ROLE_LABEL } from '../../lib/format';
import { Badge, EmptyState, Skeleton, Tabs } from '../ui';
import { Icon } from '../Icon';
import { ContentCover } from '../Cover';
import { isPersonalSite } from '../../lib/site';
import { DEFAULT_HERO, heroLines } from '../../lib/customize';
import { blockProp } from '../../lib/blocks';
import { useT } from '../../lib/i18n';

/** 经典（纸白）区块：首屏、内容流、订阅横幅。与改版前的首页结构一致。 */
function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

function ClassicHero({ block }: { block: BlockInstance }) {
  const t = useT();
  const { site, me, config } = useAuth();
  const { all, loading } = useFeed();
  const personal = isPersonalSite(config);
  const title = blockProp(block, 'title', '').trim();
  const lede = blockProp(block, 'lede', '').trim();
  const heroTitle = title || DEFAULT_HERO.title;
  const heroKicker = t('{name} · 独立出版', { name: site?.name ?? 'Practacu Press' });
  const heroLede =
    lede ||
    site?.description ||
    t('一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。');
  const feature = all[0];
  const latestDate = all[0]?.published_at ?? all[0]?.created_at;

  return (
    <section className="hero fade-up">
      <div>
        <p className="hero-kicker">{heroKicker}</p>
        <h1>
          {heroLines(heroTitle).map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line.map((segment, index) =>
                segment.em ? (
                  <em key={index}>{segment.text}</em>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </Fragment>
          ))}
        </h1>
        <p className="hero-lede">{heroLede}</p>
        <div className="hero-cta">
          {me ? (
            <Link to="/admin/content/new/article" className="btn btn-primary btn-lg">
              {t('开始写一篇')} <Icon name="arrow-right" size={15} />
            </Link>
          ) : personal ? (
            <Link
              to={feature ? contentUrl(feature) : '/articles'}
              className="btn btn-primary btn-lg"
            >
              {t('开始阅读')} <Icon name="arrow-right" size={15} />
            </Link>
          ) : (
            <Link to="/register" className="btn btn-primary btn-lg">
              {t('成为邻居')} <Icon name="arrow-right" size={15} />
            </Link>
          )}
          <Link to="/articles" className="btn btn-secondary btn-lg">
            {t('浏览文章')}
          </Link>
        </div>
        <div className="hero-meta">
          <span>
            <Icon name="file" size={12} /> {t('本页收录')} <b>{all.length}</b> {t('篇')}
          </span>
          <span>
            <Icon name="clock" size={12} /> {t('更新于 {date}', { date: formatDate(latestDate) })}
          </span>
          {site ? (
            <span>
              <Icon name="shield" size={12} /> {PUBLISH_LABEL[site.publish_mode]}
            </span>
          ) : null}
          {me ? (
            <span>
              <Icon name="user" size={12} /> {ROLE_LABEL[me.role]}
            </span>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="hero-feature">
          <Skeleton lines={5} />
        </div>
      ) : feature ? (
        <div className="hero-feature">
          <Link to={contentUrl(feature)} aria-label={feature.title}>
            <ContentCover id={feature.id} label={feature.title} ratio="4 / 3" />
          </Link>
          <div className="hero-feature-body">
            <div className="hero-feature-label">
              <span>{t('本期头条')}</span>
              <span>{feature.kind === 'article' ? t('文章') : t('帖子')}</span>
            </div>
            <h2>
              <Link to={contentUrl(feature)}>{feature.title}</Link>
            </h2>
            <p>{feature.summary ?? ''}</p>
          </div>
        </div>
      ) : (
        <div className="hero-feature">
          <EmptyState
            compact
            icon="file"
            title={t('还没有内容')}
            body={t('发布第一篇文章，这里就会出现本期头条。')}
          />
        </div>
      )}
    </section>
  );
}

function StoryMeta({ item }: { item: Content }) {
  const t = useT();
  return (
    <>
      {item.author_name ? (
        <span>
          <Icon name="user" size={11} /> {item.author_name}
        </span>
      ) : null}
      <span>{formatDate(item.published_at ?? item.created_at)}</span>
      <span>{t('{count} 分钟', { count: readingTime(item.rendered_html) })}</span>
    </>
  );
}

function ClassicFeed({ block }: { block: BlockInstance }) {
  const t = useT();
  const { site, me, status, config } = useAuth();
  const { articles, posts, all, loading } = useFeed();
  const personal = isPersonalSite(config);
  const limit = blockProp(block, 'limit', 12);
  const showTabs = blockProp(block, 'show_tabs', true);
  const showSidebar = blockProp(block, 'show_sidebar', true);
  const [tab, setTab] = useState<'all' | 'article' | 'post'>('all');
  const visible = (tab === 'all' ? all : tab === 'article' ? articles : posts).slice(0, limit);
  const recommended = articles.slice(0, 3);

  return (
    <div className="feed-layout">
      <div>
        <div className="feed-head">
          <h2>{t('最新')}</h2>
          {showTabs ? (
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { key: 'all', label: t('全部'), count: all.length },
                { key: 'article', label: t('文章'), count: articles.length },
                { key: 'post', label: t('帖子'), count: posts.length },
              ]}
            />
          ) : null}
        </div>

        {loading ? (
          <div className="mt-24">
            <Skeleton lines={6} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon="file"
            title={tab === 'post' ? t('还没有帖子') : t('还没有文章')}
            body={
              status === 'anonymous'
                ? t('这个站点可能只对成员开放，或者内容还在审核队列里。')
                : t('写下第一篇，或者去审核队列看看有没有待处理的稿子。')
            }
            action={
              me ? (
                <Link to="/admin/content/new/article" className="btn btn-secondary btn-sm">
                  {t('新建草稿')}
                </Link>
              ) : null
            }
          />
        ) : (
          <div>
            {visible.map((item, index) => (
              <article className="story" key={item.id}>
                <span className="story-index">{String(index + 1).padStart(2, '0')}</span>
                <div className="story-body">
                  <div className="row gap-8 mb-8">
                    <span className="story-kind">{item.kind === 'article' ? t('文章') : t('帖子')}</span>
                    {item.status !== 'published' ? <Badge tone="warn">{t('未发布')}</Badge> : null}
                  </div>
                  <h3>
                    <Link to={contentUrl(item)}>{item.title}</Link>
                  </h3>
                  <p>{item.summary ?? ''}</p>
                  <div className="story-meta">
                    <StoryMeta item={item} />
                  </div>
                </div>
                <div className="story-side" aria-hidden>
                  <Icon name="arrow-up-right" size={16} />
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="feed-more">
          <Link to={tab === 'post' ? '/posts' : '/articles'} className="btn btn-secondary">
            {tab === 'post' ? t('查看全部帖子') : t('查看全部文章')}
          </Link>
        </div>
      </div>

      {showSidebar ? (
        <aside className="side">
          <div className="side-inner">
            <section className="side-block">
              <h3>{t('编辑推荐')}</h3>
              <div className="side-list">
                {(recommended.length ? recommended : articles).slice(0, 3).map((item) => (
                  <Link key={item.id} to={contentUrl(item)} className="side-story">
                    <strong>{item.title}</strong>
                    <span>
                      {item.author_name ?? t('编辑部')} · {formatDate(item.published_at ?? item.created_at)}
                    </span>
                  </Link>
                ))}
                {!articles.length ? (
                  <p className="side-note">{t('发布文章后，这里会出现编辑推荐。')}</p>
                ) : null}
              </div>
            </section>

            <section className="side-block">
              <h3>{t('关于本站')}</h3>
              <div className="side-facts">
                <div className="side-fact">
                  <span>{t('访客模式')}</span>
                  <b>{site ? VISIBILITY_LABEL[site.visibility_mode] : '—'}</b>
                </div>
                <div className="side-fact">
                  <span>{t('发布模式')}</span>
                  <b>{site ? PUBLISH_LABEL[site.publish_mode] : '—'}</b>
                </div>
                <div className="side-fact">
                  <span>{t('域名')}</span>
                  <b>{site?.domain ?? '—'}</b>
                </div>
                <div className="side-fact">
                  <span>{t('当前身份')}</span>
                  <b>{me ? ROLE_LABEL[me.role] : t('访客')}</b>
                </div>
              </div>
            </section>

            <section className="side-block">
              <p className="side-quote">
                {t('“房子不必大。能遮雨，能招待几个朋友，能让写作者在夜里安静地改一段话，就够了。”')}
              </p>
              <footer>{t('发刊词 · 为小型刊物建一座自己的房子')}</footer>
            </section>

            {!me ? (
              personal ? (
                <section className="side-block">
                  <h3>{t('一个人的书房')}</h3>
                  <p className="side-note">
                    {t('本站是个人博客，不开放注册。你可以直接阅读全部已发布内容，也可以按关键词找旧文。')}
                  </p>
                  <Link to="/search" className="btn btn-secondary btn-sm mt-12">
                    {t('搜索文章')}
                  </Link>
                </section>
              ) : (
                <section className="side-block">
                  <h3>{t('成为邻居')}</h3>
                  <p className="side-note">
                    {t('注册后可以评论、收藏、关注作者，也可以提交自己的稿子。邮箱与密码即可登录。')}
                  </p>
                  <Link to="/register" className="btn btn-primary btn-sm mt-12">
                    {t('创建账户')}
                  </Link>
                </section>
              )
            ) : (
              <section className="side-block">
                <h3>{t('写点什么')}</h3>
                <p className="side-note">
                  {t('支持 Markdown、HTML 与纯文本。保存为草稿后，按站点的发布模式提交审核。')}
                </p>
                <Link to="/admin/content/new/article" className="btn btn-secondary btn-sm mt-12">
                  {t('新建草稿')}
                </Link>
              </section>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function ClassicJoinBand({ block }: { block: BlockInstance }) {
  const t = useT();
  const { me, config } = useAuth();
  const personal = isPersonalSite(config);
  const title = blockProp(block, 'title', '').trim();
  const body = blockProp(block, 'body', '').trim();
  const primary = blockProp(block, 'primary', '').trim();
  const secondary = blockProp(block, 'secondary', '').trim();

  const defaultTitle = me
    ? t('这间房子还空着一间书房。')
    : personal
      ? t('一个人的书房，门一直开着。')
      : t('订阅一位邻居，比追一条热点更长久。');
  const defaultBody = me
    ? t('你可以写文章、发帖子，或者只留在评论区。所有内容都会经过站点的发布规则。')
    : personal
      ? t('本站不开放注册，也不需要关注或收藏。你可以直接读，或者按主题搜索。')
      : t('注册一个账户，参与评论与收藏；也可以直接匿名阅读公开内容。');

  return (
    <section className="join-band">
      <div>
        <h2>{title || defaultTitle}</h2>
        <p>{body || defaultBody}</p>
      </div>
      <div className="row gap-8">
        {me ? (
          <>
            <Link to="/admin/content/new/article" className="btn btn-primary btn-md">
              {primary || t('开始写作')}
            </Link>
            <Link to="/notifications" className="btn btn-secondary btn-md">
              {secondary || t('查看通知')}
            </Link>
          </>
        ) : personal ? (
          <>
            <Link to="/articles" className="btn btn-primary btn-md">
              {primary || t('全部文章')}
            </Link>
            <Link to="/search" className="btn btn-secondary btn-md">
              {secondary || t('搜索')}
            </Link>
          </>
        ) : (
          <>
            <Link to="/register" className="btn btn-primary btn-md">
              {primary || t('创建账户')}
            </Link>
            <Link to="/login" className="btn btn-secondary btn-md">
              {secondary || t('已有账户')}
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

export const CLASSIC_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'classic-hero': ClassicHero,
  feed: ClassicFeed,
  'join-band': ClassicJoinBand,
};
