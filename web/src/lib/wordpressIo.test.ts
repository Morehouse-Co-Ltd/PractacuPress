import { describe, expect, it } from 'vitest';
import {
  absolutizeMediaUrls,
  buildTypechoXml,
  buildWordPressWxr,
  cdata,
  detectImportFormat,
  escapeXml,
  exportFilename,
  normalizeSlug,
  parseImportXml,
  parseTypechoXml,
  parseWordPressWxr,
  uniqueSlug,
  type ExportPayload,
} from './wordpressIo';

const ORIGIN = 'https://press.example.com';

function payload(overrides: Partial<ExportPayload> = {}): ExportPayload {
  return {
    siteName: 'Practacu Press',
    siteUrl: ORIGIN,
    siteDescription: '一个用来测试的站点 & 备份',
    language: 'zh-CN',
    authorName: 'Ada Lovelace',
    origin: ORIGIN,
    generatedAt: new Date('2026-11-14T12:00:00.000Z'),
    items: [
      {
        id: 'art_1',
        kind: 'article',
        title: 'Hello <WordPress> & "friends"',
        slug: 'hello-world',
        summary: '摘要 & 提要',
        html: '<p>正文 <img src="/api/v1/media/ast_1" alt="封面"> <a href="https://example.org">外链</a></p>',
        source: '# 正文\n\n![封面](/api/v1/media/ast_1)',
        source_format: 'markdown',
        status: 'published',
        published_at: '2026-11-01T08:30:00.000Z',
        created_at: '2026-10-31T08:30:00.000Z',
        updated_at: '2026-11-02T08:30:00.000Z',
        tags: ['技术', 'typecho'],
        category: '随笔',
        author: 'Ada',
      },
      {
        id: 'post_1',
        kind: 'post',
        title: '一条独立的帖子',
        slug: 'short-note',
        html: '<p>短内容 100% 完成</p>',
        source: '短内容 100% 完成',
        source_format: 'markdown',
        status: 'draft',
        created_at: '2026-11-05T08:30:00.000Z',
        updated_at: '2026-11-05T08:30:00.000Z',
        tags: [],
      },
    ],
    comments: [
      {
        content_id: 'art_1',
        id: 'cmt_1',
        author: '读者甲',
        body: '第一条评论 & 补充',
        created_at: '2026-11-03T09:00:00.000Z',
        approved: true,
      },
      {
        content_id: 'art_1',
        id: 'cmt_2',
        parent_id: 'cmt_1',
        author: '读者乙',
        body: '回复 <b>第一条</b>',
        created_at: '2026-11-03T10:00:00.000Z',
        approved: false,
      },
    ],
    ...overrides,
  };
}

describe('XML 转义', () => {
  it('转义文本节点与属性里的特殊字符', () => {
    expect(escapeXml(`<a href="x">& ' "`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp; &apos; &quot;',
    );
  });

  it('丢掉 XML 1.0 不允许的控制字符', () => {
    expect(escapeXml('a\u0000b\u0008c\u001fd')).toBe('abcd');
  });

  it('CDATA 里出现 ]]> 时按规则拆段', () => {
    const escaped = cdata('a ]]> b');
    expect(escaped).toBe('<![CDATA[a ]]]]><![CDATA[> b]]>');
  });
});

describe('WordPress WXR 导出', () => {
  const xml = buildWordPressWxr(payload());

  it('写出 WXR 1.2 的命名空间与频道信息', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:wp="http://wordpress.org/export/1.2/"');
    expect(xml).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    expect(xml).toContain('<wp:base_site_url>https://press.example.com</wp:base_site_url>');
    expect(xml).toContain('<language>zh-CN</language>');
  });

  it('按文章 / 帖子写出 wp:post_type 与分类标签', () => {
    expect(xml).toContain('<wp:post_type>post</wp:post_type>');
    expect(xml).toContain('<wp:post_type>page</wp:post_type>');
    // 中文分类用稳定短哈希做 nicename，避免多个中文分类共用同一个别名
    expect(xml).toMatch(
      /<category domain="category" nicename="term-[a-z0-9]+"><!\[CDATA\[随笔\]\]><\/category>/,
    );
    expect(xml).toContain(
      '<category domain="post_tag" nicename="typecho"><![CDATA[typecho]]></category>',
    );
    expect(xml).toContain('<wp:status>publish</wp:status>');
    expect(xml).toContain('<wp:status>draft</wp:status>');
  });

  it('正文来自 HTML，并把站内媒体改写成绝对地址', () => {
    expect(xml).toContain(
      '<![CDATA[<p>正文 <img src="https://press.example.com/api/v1/media/ast_1"',
    );
    // 外链保持原样
    expect(xml).toContain('https://example.org');
    // 没有残留的站内相对媒体地址
    expect(xml).not.toContain('src="/api/v1/media/ast_1"');
  });

  it('评论嵌在所属文章下，并保留作者与审核状态', () => {
    expect(xml).toContain('<wp:comment_author><![CDATA[读者甲]]></wp:comment_author>');
    expect(xml).toContain('<wp:comment_approved>1</wp:comment_approved>');
    expect(xml).toContain('<wp:comment_approved>0</wp:comment_approved>');
    // 第二条评论的 parent 指向第一条（全局评论 id 从 1 开始）
    expect(xml).toContain('<wp:comment_parent>1</wp:comment_parent>');
  });

  it('标题与摘要按 XML 规则转义', () => {
    expect(xml).toContain('<title>Hello &lt;WordPress&gt; &amp; &quot;friends&quot;</title>');
    expect(xml).toContain('<description><![CDATA[摘要 & 提要]]></description>');
  });
});

describe('Typecho 导出', () => {
  const xml = buildTypechoXml(payload());

  it('写出 typecho 根节点与 site 信息', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<typecho version="1.2">');
    expect(xml).toContain('<generator>Practacu Press</generator>');
    expect(xml).toContain('<language>zh-CN</language>');
    expect(xml).toContain('<exportedAt>2026-11-14T12:00:00.000Z</exportedAt>');
  });

  it('按 Typecho 字段顺序写文章、Markdown 正文与评论', () => {
    expect(xml).toContain('<cid>1</cid>');
    expect(xml).toContain('<status>publish</status>');
    expect(xml).toContain('<status>draft</status>');
    expect(xml).toContain('<type>post</type>');
    expect(xml).toContain('<type>page</type>');
    expect(xml).toContain('<sourceFormat>markdown</sourceFormat>');
    expect(xml).toContain('<summary><![CDATA[摘要 & 提要]]></summary>');
    // Markdown 正文优先，图片地址绝对化
    expect(xml).toContain('# 正文\n\n![封面](https://press.example.com/api/v1/media/ast_1)');
    expect(xml).toContain(
      `<created>${Math.floor(Date.parse('2026-10-31T08:30:00.000Z') / 1000)}</created>`,
    );
    expect(xml).toContain('<coid>1</coid>');
    expect(xml).toContain('<author><![CDATA[读者甲]]></author>');
    expect(xml).toContain('<status>approved</status>');
    expect(xml).toContain('<status>waiting</status>');
  });
});

describe('WordPress WXR 解析', () => {
  it('解析真实形状的 WXR：item、content:encoded CDATA、分类标签与内嵌评论', () => {
    const source = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>别人的博客</title>
    <link>https://old.example.com</link>
    <description>旧站</description>
    <wp:wxr_version>1.2</wp:wxr_version>
    <item>
      <title>第一篇文章</title>
      <link>https://old.example.com/?p=12</link>
      <dc:creator><![CDATA[原作者]]></dc:creator>
      <content:encoded><![CDATA[<p>一段 <strong>旧</strong> 正文 ]]]]><![CDATA[> 结尾</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[旧摘要]]></excerpt:encoded>
      <wp:post_id>12</wp:post_id>
      <wp:post_date>2025-01-02 03:04:05</wp:post_date>
      <wp:post_name>first-post</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="news"><![CDATA[新闻]]></category>
      <category domain="post_tag" nicename="go"><![CDATA[Go]]></category>
      <wp:comment>
        <wp:comment_id>3</wp:comment_id>
        <wp:comment_author><![CDATA[路人]]></wp:comment_author>
        <wp:comment_date_gmt>2025-01-03 04:05:06</wp:comment_date_gmt>
        <wp:comment_content><![CDATA[评论 & 内容]]></wp:comment_content>
        <wp:comment_approved>1</wp:comment_approved>
        <wp:comment_parent>0</wp:comment_parent>
      </wp:comment>
    </item>
    <item>
      <title>一个旧页面</title>
      <content:encoded><![CDATA[<p>页面正文</p>]]></content:encoded>
      <wp:post_id>13</wp:post_id>
      <wp:status>draft</wp:status>
      <wp:post_name>old-page</wp:post_name>
      <wp:post_type>page</wp:post_type>
    </item>
    <item>
      <title>一张图片</title>
      <wp:post_id>14</wp:post_id>
      <wp:status>inherit</wp:status>
      <wp:post_type>attachment</wp:post_type>
    </item>
  </channel>
</rss>`;

    expect(detectImportFormat(source)).toBe('wordpress-wxr');
    const parsed = parseImportXml(source);
    expect(parsed.format).toBe('wordpress-wxr');
    expect(parsed.title).toBe('别人的博客');
    expect(parsed.url).toBe('https://old.example.com');
    expect(parsed.posts).toHaveLength(2);
    // post → 站内文章；page → 站内帖子
    expect(parsed.posts[0]).toMatchObject({
      sourceId: '12',
      kind: 'article',
      title: '第一篇文章',
      slug: 'first-post',
      summary: '旧摘要',
      source_format: 'html',
      published: true,
      categories: ['新闻'],
      tags: ['Go'],
      author: '原作者',
    });
    expect(parsed.posts[0].body).toBe('<p>一段 <strong>旧</strong> 正文 ]]> 结尾</p>');
    expect(parsed.posts[0].published_at).toBe('2025-01-02T03:04:05.000Z');
    expect(parsed.posts[1]).toMatchObject({
      sourceId: '13',
      kind: 'post',
      slug: 'old-page',
      published: false,
    });
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]).toMatchObject({
      postSourceId: '12',
      id: '3',
      author: '路人',
      body: '评论 & 内容',
      approved: true,
    });
    // attachment 被跳过并给出提示
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: 'unsupported_post_type', detail: 'attachment', count: 1 }),
    ]);
  });

  it('缺少标题与正文时给出提示', () => {
    const parsed = parseWordPressWxr(`<?xml version="1.0"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/"><channel>
  <wp:wxr_version>1.2</wp:wxr_version>
  <item><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type></item>
</channel></rss>`);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['empty_title', 'empty_body']),
    );
  });

  it('拒绝损坏的 XML 与带 DOCTYPE 的文件', () => {
    const truncated =
      '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>x</title>';
    expect(() => parseImportXml(truncated)).toThrowError('invalid_xml');
    expect(() =>
      parseImportXml(
        '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "boom">]><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version></channel></rss>',
      ),
    ).toThrowError('unsafe_xml');
  });

  it('无法识别的格式返回 unknown_format', () => {
    expect(detectImportFormat('<opml><body/></opml>')).toBe('unknown');
    expect(() => parseImportXml('<opml><body/></opml>')).toThrowError('unknown_format');
  });
});

describe('Typecho 解析', () => {
  it('解析备份风格的 posts / comments', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<typecho version="1.2">
  <site>
    <title>Typecho 站</title>
    <url>https://typecho.example.com</url>
    <description>旧站</description>
  </site>
  <posts>
    <post>
      <cid>7</cid>
      <title>Typecho 文章</title>
      <slug>typecho-post</slug>
      <created>1700000000</created>
      <modified>1700001000</modified>
      <text><![CDATA[# 标题

正文]]></text>
      <status>publish</status>
      <type>post</type>
      <categories><category><![CDATA[分类甲]]></category></categories>
      <tags><tag><![CDATA[标签甲]]></tag></tags>
      <comments>
        <comment>
          <coid>9</coid>
          <cid>7</cid>
          <parent>0</parent>
          <author><![CDATA[评论者]]></author>
          <text><![CDATA[好文]]></text>
          <created>1700002000</created>
          <status>approved</status>
        </comment>
      </comments>
    </post>
    <post>
      <cid>8</cid>
      <title>附件占位</title>
      <text>x</text>
      <status>publish</status>
      <type>attachment</type>
    </post>
  </posts>
</typecho>`;

    expect(detectImportFormat(source)).toBe('typecho');
    const parsed = parseImportXml(source);
    expect(parsed.format).toBe('typecho');
    expect(parsed.title).toBe('Typecho 站');
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0]).toMatchObject({
      sourceId: '7',
      kind: 'article',
      title: 'Typecho 文章',
      slug: 'typecho-post',
      source_format: 'markdown',
      published: true,
      categories: ['分类甲'],
      tags: ['标签甲'],
    });
    expect(parsed.posts[0].body).toBe('# 标题\n\n正文');
    expect(parsed.posts[0].published_at).toBe(new Date(1700000000 * 1000).toISOString());
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]).toMatchObject({
      postSourceId: '7',
      id: '9',
      author: '评论者',
      body: '好文',
      approved: true,
    });
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: 'unsupported_post_type', detail: 'attachment', count: 1 }),
    ]);
  });

  it('没有 sourceFormat 时按正文字面推断 html / markdown', () => {
    const parsed = parseTypechoXml(`<typecho><posts>
      <post><cid>1</cid><title>A</title><text>&lt;p&gt;html&lt;/p&gt;</text><status>publish</status><type>post</type></post>
      <post><cid>2</cid><title>B</title><text># 标题</text><status>draft</status><type>post</type></post>
    </posts></typecho>`);
    expect(parsed.posts[0].source_format).toBe('html');
    expect(parsed.posts[1].source_format).toBe('markdown');
  });

  it('根节点评论按 cid 关联文章，无法关联时提示 orphan_comment', () => {
    const parsed = parseTypechoXml(`<typecho><posts>
      <post><cid>1</cid><title>A</title><text>正文</text><status>publish</status><type>post</type></post>
    </posts>
    <comments>
      <comment><coid>1</coid><cid>1</cid><author>甲</author><text>评论</text><status>approved</status></comment>
      <comment><coid>2</coid><cid>99</cid><author>乙</author><text>无主评论</text><status>approved</status></comment>
    </comments></typecho>`);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].postSourceId).toBe('1');
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: 'orphan_comment', count: 1 }),
    ]);
  });
});

describe('往返（导出再导入）', () => {
  it('WordPress WXR 往返后保留标题、正文、分类标签与评论', () => {
    const parsed = parseImportXml(buildWordPressWxr(payload()));
    expect(parsed.format).toBe('wordpress-wxr');
    expect(parsed.posts).toHaveLength(2);
    const article = parsed.posts[0];
    expect(article.kind).toBe('article');
    expect(article.title).toBe('Hello <WordPress> & "friends"');
    expect(article.slug).toBe('hello-world');
    expect(article.summary).toBe('摘要 & 提要');
    expect(article.categories).toEqual(['随笔']);
    expect(article.tags).toEqual(['技术', 'typecho']);
    expect(article.source_format).toBe('html');
    expect(article.published).toBe(true);
    // 媒体地址已经在导出时绝对化，导入后保持绝对地址
    expect(article.body).toContain('https://press.example.com/api/v1/media/ast_1');
    expect(parsed.posts[1].kind).toBe('post');
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.comments[0].body).toBe('第一条评论 & 补充');
    expect(parsed.comments[1].parentId).toBe(parsed.comments[0].id);
    expect(parsed.comments[1].approved).toBe(false);
  });

  it('Typecho XML 往返后保留 Markdown 正文、类型与评论', () => {
    const parsed = parseImportXml(buildTypechoXml(payload()));
    expect(parsed.format).toBe('typecho');
    expect(parsed.posts).toHaveLength(2);
    const article = parsed.posts[0];
    expect(article.kind).toBe('article');
    expect(article.title).toBe('Hello <WordPress> & "friends"');
    expect(article.slug).toBe('hello-world');
    expect(article.source_format).toBe('markdown');
    expect(article.summary).toBe('摘要 & 提要');
    expect(article.body).toContain(
      '![封面](https://press.example.com/api/v1/media/ast_1)',
    );
    expect(article.tags).toEqual(['技术', 'typecho']);
    expect(parsed.posts[1].kind).toBe('post');
    expect(parsed.comments[0]).toMatchObject({
      author: '读者甲',
      body: '第一条评论 & 补充',
      approved: true,
    });
    expect(parsed.comments[1].parentId).toBe(parsed.comments[0].id);
  });

  it('内容里的 ]]> 与 & 能完整往返', () => {
    const tricky = payload({
      items: [
        {
          id: 'art_x',
          kind: 'article',
          title: 'tricky',
          slug: 'tricky',
          html: '<p>a ]]> b &amp; c</p>',
          source: 'a ]]> b & c',
          source_format: 'markdown',
          status: 'published',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      comments: [],
    });
    expect(parseImportXml(buildWordPressWxr(tricky)).posts[0].body).toBe(
      '<p>a ]]> b &amp; c</p>',
    );
    expect(parseImportXml(buildTypechoXml(tricky)).posts[0].body).toBe('a ]]> b & c');
  });
});

describe('工具函数', () => {
  it('slug 规范化与冲突后缀', () => {
    expect(normalizeSlug('Hello World!')).toBe('hello-world');
    expect(normalizeSlug('中文标题')).toBe('');
    expect(normalizeSlug('  --A__B--  ')).toBe('a-b');
    expect(normalizeSlug('Café')).toBe('cafe');
    const taken = new Set<string>(['hello']);
    expect(uniqueSlug('hello', taken)).toBe('hello-2');
    expect(uniqueSlug('hello', taken)).toBe('hello-3');
    expect(uniqueSlug('', taken)).toBe('');
  });

  it('媒体地址绝对化只改站内相对地址', () => {
    const html =
      '<img src="/api/v1/media/a" srcset="/api/v1/media/a?w=320 320w, https://cdn.example.com/b 640w">' +
      '<video poster="/media/poster.jpg"></video><a href="/about">关于</a>';
    const out = absolutizeMediaUrls(html, 'https://press.example.com/');
    expect(out).toContain('src="https://press.example.com/api/v1/media/a"');
    expect(out).toContain('srcset="https://press.example.com/api/v1/media/a?w=320 320w');
    expect(out).toContain('poster="https://press.example.com/media/poster.jpg"');
    // 普通站内链接不在媒体范围内
    expect(out).toContain('href="/about"');
    // Markdown 图片
    expect(absolutizeMediaUrls('![x](/api/v1/media/b)', 'https://press.example.com')).toBe(
      '![x](https://press.example.com/api/v1/media/b)',
    );
    // 协议相对地址不动
    expect(absolutizeMediaUrls('<img src="//cdn.example.com/a.png">', ORIGIN)).toBe(
      '<img src="//cdn.example.com/a.png">',
    );
  });

  it('导出文件名带格式与时间', () => {
    const at = new Date(2026, 10, 14, 19, 30);
    expect(exportFilename('wordpress-wxr', at)).toBe('practacu-press-wordpress-20261114-1930.xml');
    expect(exportFilename('typecho', at)).toBe('practacu-press-typecho-20261114-1930.xml');
  });
});
