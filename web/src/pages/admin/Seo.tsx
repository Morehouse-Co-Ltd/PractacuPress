import { useEffect, useMemo, useState } from 'react';
import type { Content, PermalinkPattern } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import {
  buildSitemap,
  composeTitle,
  robotsTxt,
  siteOrigin,
  sitemapXml,
} from '../../lib/seo';
import { Button, Callout, CopyButton, Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';
import { isValidPermalinkTemplate, permalinkStructureFor } from '../../lib/permalinks';

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function previewPermalink(
  structure: string,
  custom: string,
  kind: 'article' | 'post',
): string {
  if (structure === 'legacy') return kind === 'article' ? '/a/example-article' : '/p/example-post';
  if (structure === 'date_name') return '/2026/11/19/example-post';
  if (structure === 'month_name') return '/2026/11/example-post';
  if (structure === 'numeric') return '/archives/123';
  if (structure === 'post_name') return '/example-post';
  return custom
    .replaceAll('%year%', '2026')
    .replaceAll('%monthnum%', '11')
    .replaceAll('%day%', '19')
    .replaceAll('%postname%', kind === 'article' ? 'example-article' : 'example-post')
    .replaceAll('%post_id%', '123');
}

function appendPermalinkAlias(
  existing: PermalinkPattern[] | undefined,
  previous: PermalinkPattern,
): PermalinkPattern[] {
  const aliases = [...(existing ?? [])];
  const duplicate = aliases.some(
    (item) => item.structure === previous.structure && item.custom === previous.custom,
  );
  if (!duplicate) aliases.push(previous);
  return aliases.slice(-12);
}

export function SeoPage() {
  const t = useT();
  useTitle('SEO');
  return (
    <RoleGate capability="manage_site" need={t('配置 SEO')}>
      <SeoWorkspace />
    </RoleGate>
  );
}

function SeoWorkspace() {
  const t = useT();
  const { site } = useAuth();
  const backend = useBackend();
  const { customization, update } = useCustomization();
  const seo = customization.seo;
  const feed = customization.feed;
  const toast = useToast();
  const [tab, setTab] = useState<'meta' | 'files'>('meta');
  const [articleCustom, setArticleCustom] = useState(seo.permalinks.article_custom);
  const [postCustom, setPostCustom] = useState(seo.permalinks.post_custom);

  const origin = siteOrigin(seo, window.location.origin);
  const siteName = site?.name ?? 'Practacu Press';

  const contents = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return [...articles.items, ...posts.items];
  }, [backend]);

  const published = useMemo(
    () => (contents.data ?? []).filter((item: Content) => item.status === 'published'),
    [contents.data],
  );

  const entries = useMemo(
    () =>
      buildSitemap({
        origin,
        contents: contents.data ?? [],
        pages: customization.pages,
      }),
    [origin, contents.data, customization.pages],
  );
  const sitemap = useMemo(() => sitemapXml(entries), [entries]);
  const robots = useMemo(() => robotsTxt({ origin, indexable: seo.indexable }), [origin, seo.indexable]);

  const previewTitle = composeTitle(
    seo.title_template,
    published[0]?.title ?? t('一篇文章的标题'),
    siteName,
  );
  const previewDescription =
    seo.default_description ||
    site?.description ||
    t('站点默认描述会出现在这里，约 120–160 字最合适。');

  const patch = (next: Partial<typeof seo>) => update({ seo: { ...seo, ...next } });
  const patchFeed = (next: Partial<typeof feed>) => update({ feed: { ...feed, ...next } });

  useEffect(() => setArticleCustom(seo.permalinks.article_custom), [seo.permalinks.article_custom]);
  useEffect(() => setPostCustom(seo.permalinks.post_custom), [seo.permalinks.post_custom]);

  const patchPermalinks = (next: Partial<typeof seo.permalinks>) => {
    const current = seo.permalinks;
    const updated = { ...current, ...next };
    const articleChanged =
      current.article_structure !== updated.article_structure || current.article_custom !== updated.article_custom;
    const previousPost = permalinkStructureFor('post', current);
    const nextPost = permalinkStructureFor('post', updated);
    const postChanged = previousPost.structure !== nextPost.structure || previousPost.custom !== nextPost.custom;

    if (articleChanged) updated.article_aliases = appendPermalinkAlias(current.article_aliases, {
      structure: current.article_structure,
      custom: current.article_custom,
    });
    if (postChanged) updated.post_aliases = appendPermalinkAlias(current.post_aliases, {
      structure: previousPost.structure,
      custom: previousPost.custom,
    });
    patch({ permalinks: updated });
  };

  const structureOptions = [
    ['date_name', t('日期和名称型')],
    ['month_name', t('月份和名称型')],
    ['numeric', t('数字型')],
    ['post_name', t('文章名')],
    ['custom', t('自定义结构')],
    ['legacy', t('默认类型路径')],
  ] as const;

  return (
    <>
      <div className="admin-page-head">
        <div>
          <p className="eyebrow">SEO</p>
          <h1>{t('搜索引擎与分享卡片')}</h1>
          <p>{t('标题模板、描述、canonical、结构化数据，以及可直接下载的 sitemap / robots。')}</p>
        </div>
        <div className="admin-page-actions">
          <div className="row gap-6">
            <button
              type="button"
              className={`pill${tab === 'meta' ? ' is-on' : ''}`}
              onClick={() => setTab('meta')}
            >
              {t('站点信息')}
            </button>
            <button
              type="button"
              className={`pill${tab === 'files' ? ' is-on' : ''}`}
              onClick={() => setTab('files')}
            >
              {t('站点地图')}
            </button>
          </div>
        </div>
      </div>

      <Callout tone="info" icon="info" title={t('单页应用的边界')}>
        {t('这些标签由前端写入')}{' '}
        <code className="mono">&lt;head&gt;</code>
        {t(
          '：Google、Bing、百度会执行 JavaScript，能读到它们；大多数社交平台的抓取器不执行 JavaScript，分享卡片可能只拿到',
        )}
        <code className="mono"> index.html</code>{' '}
        {t('里的默认值。需要完整预渲染时，请在托管层开启 SSR 或构建期快照。')}
      </Callout>

      {tab === 'meta' ? (
        <div className="seo-grid">
          <div className="editor-main">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('搜索结果样式')}</h3>
                  <p>{t('标题模板支持 {title} 与 {site} 两个占位符。')}</p>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Field
                    label={t('标题模板')}
                    htmlFor="seo-title-template"
                    hint={t('推荐「{title} · {site}」，过长会被截断。')}
                  >
                    <Input
                      id="seo-title-template"
                      value={seo.title_template}
                      onChange={(event) => patch({ title_template: event.target.value })}
                      maxLength={120}
                    />
                  </Field>
                  <Field
                    label={t('默认描述')}
                    htmlFor="seo-description"
                    aside={`${seo.default_description.length}/300`}
                    hint={t('文章没有摘要时使用；建议 120–160 字。')}
                  >
                    <Textarea
                      id="seo-description"
                      value={seo.default_description}
                      onChange={(event) => patch({ default_description: event.target.value })}
                      maxLength={300}
                      style={{ minHeight: 80 }}
                    />
                  </Field>
                  <div className="form-grid">
                    <Field
                      label={t('关键词')}
                      htmlFor="seo-keywords"
                      hint={t('逗号分隔。现代搜索引擎基本忽略，但无害。')}
                    >
                      <Input
                        id="seo-keywords"
                        value={seo.keywords}
                        onChange={(event) => patch({ keywords: event.target.value })}
                        maxLength={300}
                        placeholder={t('独立出版, 写作, 社区')}
                      />
                    </Field>
                    <Field
                      label={t('发布者名称')}
                      htmlFor="seo-publisher"
                      hint={t('写入结构化数据的 Organization。')}
                    >
                      <Input
                        id="seo-publisher"
                        value={seo.publisher}
                        onChange={(event) => patch({ publisher: event.target.value })}
                        maxLength={120}
                        placeholder={siteName}
                      />
                    </Field>
                  </div>
                </div>

                <div className="serp-preview">
                  <p className="serp-url">{origin.replace(/^https?:\/\//, '')} › ...</p>
                  <p className="serp-title">{previewTitle}</p>
                  <p className="serp-desc">{previewDescription}</p>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('索引与地址')}</h3>
                  <p>
                    {t('关闭索引后，全站输出')}{' '}
                    <code className="mono">noindex, nofollow</code>
                    {t('。')}
                  </p>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Toggle
                    checked={seo.indexable}
                    onChange={(value) => patch({ indexable: value })}
                    label={t('允许搜索引擎收录')}
                    description={t('成员限定站点会自动关闭；后台、登录页与搜索结果页始终不收录。')}
                  />
                  <div className="form-stack">
                    <div>
                      <h4>{t('文章链接结构')}</h4>
                      <p className="field-hint">{t('选择文章和帖子的固定链接格式。修改后旧链接仍可访问并跳转。')}</p>
                    </div>
                    <Field label={t('文章')} htmlFor="article-permalink-structure">
                      <Select
                        id="article-permalink-structure"
                        value={seo.permalinks.article_structure}
                        onChange={(event) =>
                          patchPermalinks({ article_structure: event.target.value as typeof seo.permalinks.article_structure })
                        }
                      >
                        {structureOptions.map(([value, label]) => (
                          <option value={value} key={value}>{label}</option>
                        ))}
                      </Select>
                    </Field>
                    {seo.permalinks.article_structure === 'custom' ? (
                      <Field
                        label={t('文章自定义结构')}
                        htmlFor="article-permalink-custom"
                        hint={t('可用占位符 %year%、%monthnum%、%day%、%postname% 和 %post_id%。')}
                        error={!isValidPermalinkTemplate(articleCustom) ? t('结构必须以 / 开头，并包含 %postname% 或 %post_id%。') : undefined}
                      >
                        <Input
                          id="article-permalink-custom"
                          value={articleCustom}
                          onChange={(event) => {
                            const value = event.target.value;
                            setArticleCustom(value);
                            if (isValidPermalinkTemplate(value)) patchPermalinks({ article_custom: value });
                          }}
                          aria-invalid={!isValidPermalinkTemplate(articleCustom)}
                          placeholder="/%year%/%monthnum%/%day%/%postname%"
                          maxLength={200}
                        />
                      </Field>
                    ) : null}
                    <p className="small mono">{t('文章预览')} · {previewPermalink(seo.permalinks.article_structure, articleCustom, 'article')}</p>
                    <Toggle
                      checked={seo.permalinks.posts_follow_articles}
                      onChange={(posts_follow_articles) => patchPermalinks({ posts_follow_articles })}
                      label={t('帖子跟随文章链接结构')}
                    />
                    {!seo.permalinks.posts_follow_articles ? (
                      <>
                        <Field label={t('帖子')} htmlFor="post-permalink-structure">
                          <Select
                            id="post-permalink-structure"
                            value={seo.permalinks.post_structure}
                            onChange={(event) =>
                              patchPermalinks({ post_structure: event.target.value as typeof seo.permalinks.post_structure })
                            }
                          >
                            {structureOptions.map(([value, label]) => (
                              <option value={value} key={value}>{label}</option>
                            ))}
                          </Select>
                        </Field>
                        {seo.permalinks.post_structure === 'custom' ? (
                          <Field
                            label={t('帖子自定义结构')}
                            htmlFor="post-permalink-custom"
                            hint={t('可用占位符 %year%、%monthnum%、%day%、%postname% 和 %post_id%。')}
                            error={!isValidPermalinkTemplate(postCustom) ? t('结构必须以 / 开头，并包含 %postname% 或 %post_id%。') : undefined}
                          >
                            <Input
                              id="post-permalink-custom"
                              value={postCustom}
                              onChange={(event) => {
                                const value = event.target.value;
                                setPostCustom(value);
                                if (isValidPermalinkTemplate(value)) patchPermalinks({ post_custom: value });
                              }}
                              aria-invalid={!isValidPermalinkTemplate(postCustom)}
                              placeholder="/%postname%"
                              maxLength={200}
                            />
                          </Field>
                        ) : null}
                      </>
                    ) : null}
                    <p className="small mono">{t('帖子预览')} · {previewPermalink(
                      seo.permalinks.posts_follow_articles ? seo.permalinks.article_structure : seo.permalinks.post_structure,
                      seo.permalinks.posts_follow_articles ? articleCustom : postCustom,
                      'post',
                    )}</p>
                  </div>
                  <Field
                    label={t('站点地址')}
                    htmlFor="seo-canonical"
                    hint={t('用于 canonical 与 sitemap；留空取当前访问地址。')}
                  >
                    <Input
                      id="seo-canonical"
                      value={seo.canonical_base}
                      onChange={(event) => patch({ canonical_base: event.target.value })}
                      placeholder="https://press.example.com"
                      maxLength={300}
                    />
                  </Field>
                  <Field
                    label={t('分享图')}
                    htmlFor="seo-image"
                    hint={t('建议 1200×630，留空则使用文章第一张图。')}
                  >
                    <Input
                      id="seo-image"
                      value={seo.share_image}
                      onChange={(event) => patch({ share_image: event.target.value })}
                      placeholder={t('/assets/share.png 或 https://...')}
                      maxLength={500}
                    />
                  </Field>
                  {seo.share_image ? (
                    <img className="seo-share-preview" src={seo.share_image} alt={t('分享图预览')} />
                  ) : null}
                  <div className="form-grid">
                    <Field label="Twitter / X" htmlFor="seo-twitter" hint={t('带不带 @ 都可以。')}>
                      <Input
                        id="seo-twitter"
                        value={seo.twitter}
                        onChange={(event) => patch({ twitter: event.target.value })}
                        maxLength={60}
                        placeholder="@press"
                      />
                    </Field>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('订阅源')}</h3>
                  <p>{t('RSS 2.0 与 Atom 1.0 由服务端直接提供；关闭后根路径返回 404。')}</p>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Toggle
                    checked={feed.enabled}
                    onChange={(value) => patchFeed({ enabled: value })}
                    label={t('启用订阅源')}
                    description={t('同时关闭 RSS 与 Atom，包括分类与标签订阅。')}
                  />
                  <Toggle
                    checked={feed.full_text}
                    onChange={(value) => patchFeed({ full_text: value })}
                    label={t('输出全文')}
                    description={t('关闭时只输出摘要；打开后包含清洗过的正文。')}
                  />
                  <NumberField
                    id="seo-feed-limit"
                    label={t('每个源最多条数')}
                    hint={t('超过内容服务的上限时会按 100 条截断。')}
                    value={feed.limit}
                    min={1}
                    max={100}
                    unit={t('条')}
                    onChange={(limit) => patchFeed({ limit })}
                  />
                  <Toggle
                    checked={feed.include_taxonomy}
                    onChange={(value) => patchFeed({ include_taxonomy: value })}
                    label={t('提供分类与标签订阅')}
                    description={t('在 /category/{slug}/ 与 /tag/{slug}/ 下提供 RSS 与 Atom。')}
                  />
                  <div className="mini-list">
                    <div className="mini-row">
                      <span className="mini-label">{t('站点订阅')}</span>
                      <span className="mini-value mono">
                        {feed.enabled ? (
                          <>
                            <a href="/rss.xml" target="_blank" rel="noreferrer">
                              /rss.xml
                            </a>
                            {' · '}
                            <a href="/atom.xml" target="_blank" rel="noreferrer">
                              /atom.xml
                            </a>
                          </>
                        ) : (
                          t('已关闭')
                        )}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('分类与标签订阅')}</span>
                      <span className="mini-value mono">
                        {feed.include_taxonomy ? '/category/{slug}/rss.xml · /tag/{slug}/rss.xml' : t('已关闭')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('站长验证')}</h3>
                  <p>{t('把搜索平台给的验证值填进来，会输出对应的 meta 标签。')}</p>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-grid">
                  <Field label="Google" htmlFor="seo-verify-google" hint="google-site-verification">
                    <Input
                      id="seo-verify-google"
                      value={seo.verification.google}
                      onChange={(event) =>
                        patch({ verification: { ...seo.verification, google: event.target.value } })
                      }
                      maxLength={120}
                    />
                  </Field>
                  <Field label={t('百度')} htmlFor="seo-verify-baidu" hint="baidu-site-verification">
                    <Input
                      id="seo-verify-baidu"
                      value={seo.verification.baidu}
                      onChange={(event) =>
                        patch({ verification: { ...seo.verification, baidu: event.target.value } })
                      }
                      maxLength={120}
                    />
                  </Field>
                  <Field label="Bing" htmlFor="seo-verify-bing" hint="msvalidate.01">
                    <Input
                      id="seo-verify-bing"
                      value={seo.verification.bing}
                      onChange={(event) =>
                        patch({ verification: { ...seo.verification, bing: event.target.value } })
                      }
                      maxLength={120}
                    />
                  </Field>
                </div>
              </div>
            </section>
          </div>

          <aside className="settings-side">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('当前生效值')}</h3>
                  <p>{t('页面渲染时实际写入 head 的内容。')}</p>
                </div>
              </div>
              <div className="panel-body" style={{ paddingTop: 4 }}>
                <div className="mini-list">
                  <div className="mini-row">
                    <span className="mini-label">{t('站点地址')}</span>
                    <span className="mini-value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {origin || '—'}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('索引')}</span>
                    <span className="mini-value">
                      {seo.indexable ? t('允许收录') : t('禁止收录')}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('订阅源')}</span>
                    <span className="mini-value">
                      {feed.enabled ? t('已开启') : t('已关闭')}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('每个源最多条数')}</span>
                    <span className="mini-value">{t('{count} 条', { count: feed.limit })}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('已发布内容')}</span>
                    <span className="mini-value">{t('{count} 条', { count: published.length })}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('自定义页面')}</span>
                    <span className="mini-value">
                      {t('{count} 个', {
                        count: customization.pages.filter((page) => page.status === 'published')
                          .length,
                      })}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('sitemap 条目')}</span>
                    <span className="mini-value">{t('{count} 条', { count: entries.length })}</span>
                  </div>
                </div>
                <p className="tiny faint mt-12" style={{ lineHeight: 1.7 }}>
                  {t(
                    '结构化数据包含 WebSite、SearchAction，文章页额外输出 Article 与 BreadcrumbList。',
                  )}
                </p>
              </div>
            </section>
          </aside>
        </div>
      ) : (
        <div className="seo-files">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>sitemap.xml</h3>
                <p>{t('由已发布内容与自定义页面生成，可直接放到站点根目录。')}</p>
              </div>
              <div className="row gap-8">
                <CopyButton value={sitemap} label={t('复制')} />
                <Button
                  size="sm"
                  icon="download"
                  onClick={() => {
                    downloadFile('sitemap.xml', sitemap, 'application/xml');
                    toast.push('ok', t('已下载 sitemap.xml'));
                  }}
                >
                  {t('下载')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              <pre className="seo-code">{sitemap}</pre>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>robots.txt</h3>
                <p>{t('关闭索引时输出全站 Disallow；否则屏蔽后台与认证页并指向 sitemap。')}</p>
              </div>
              <div className="row gap-8">
                <CopyButton value={robots} label={t('复制')} />
                <Button
                  size="sm"
                  icon="download"
                  onClick={() => {
                    downloadFile('robots.txt', robots, 'text/plain');
                    toast.push('ok', t('已下载 robots.txt'));
                  }}
                >
                  {t('下载')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              <pre className="seo-code">{robots}</pre>
            </div>
          </section>

          <Callout tone="warn" icon="alert" title={t('静态托管需要手动放置')}>
            {t(
              '单页应用不能自己对外提供根目录文件。把这两个文件放到托管根目录（或反向代理里）才会生效；内容更新后重新下载一次即可。构建产物里已经附带一份默认的',
            )}
            <code className="mono"> robots.txt</code>
            {t('。')}
          </Callout>
        </div>
      )}
    </>
  );
}
