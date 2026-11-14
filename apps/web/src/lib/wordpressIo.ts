/**
 * WordPress WXR / Typecho XML 的导入导出。
 *
 * 这里只放纯逻辑：把站内内容序列化成 XML，或把上传的 XML 解析成结构化数据。
 * 它不发起任何网络请求，也不依赖 React，页面负责取数与落库。
 *
 * 导出采用两种目标格式：
 * - **WordPress WXR 1.2**：`<rss>` + `wp:` / `content:` / `excerpt:` / `dc:` 命名空间，
 *   可以直接交给 WordPress 的「工具 → 导入 → WordPress」。
 * - **Typecho 备份风格 XML**：`<typecho>` 根节点，`<posts>/<post>` 内嵌 `<comments>`，
 *   字段沿用 Typecho 数据库的 cid / text / status / created 命名，便于迁移脚本读取。
 *
 * 类型映射：站内「文章」（article，长文，带分类标签与评论）导出为 WordPress 的
 * `post`；「帖子」（post，独立短文）导出为 WordPress 的 `page`。解析时反向映射，
 * 因此本站导出再导入可以保持类型不变；同时写入 `practacu_press_kind` postmeta，
 * 其他工具改过 XML 后仍能按原始类型还原。
 *
 * 已知限制：
 * - XML 不能携带媒体二进制；正文里的站内媒体地址会被改写成站点绝对地址，导入到
 *   WordPress / Typecho 后需要由对方抓取或重新上传（页面会提示这一点）。
 * - 评论作者无法通过现有 API 指定；导入时原评论作者名会写进正文前缀。
 *
 * 解析统一使用 DOMParser（browser / happy-dom 都有），不执行任何脚本、不展开外部
 * 实体；声明了 DOCTYPE / ENTITY 的文件会被直接拒绝。
 */
import type { ContentKind, SourceFormat } from '../types';

/** 可以导出的目标格式。 */
export type ImportFormat = 'wordpress-wxr' | 'typecho';

/** 自动检测出的来源格式；无法识别时为 unknown。 */
export type DetectedFormat = ImportFormat | 'unknown';

/** 导出时的一条内容（与后端 Content 解耦，方便单测）。 */
export interface IoContent {
  /** 站内内容 id；评论按它挂到文章上。 */
  id: string;
  kind: ContentKind;
  title: string;
  slug: string;
  summary?: string;
  /** 已渲染 HTML；WXR 的 content:encoded 用它。 */
  html: string;
  /** 作者源文；Typecho 的 text 在 Markdown 内容时用它。 */
  source?: string;
  source_format: SourceFormat;
  /** 后端状态（draft / pending_review / published / …）。 */
  status: string;
  published_at?: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
  category?: string;
  author?: string;
}

/** 导出时的一条评论。 */
export interface IoComment {
  /** 所属内容 id（IoContent.id）。 */
  content_id: string;
  /** 站内评论 id；WXR 的 wp:comment_id 由它派生父子关系。 */
  id?: string;
  /** 父评论 id（同一 id 空间）。 */
  parent_id?: string;
  author: string;
  body: string;
  created_at?: string;
  /** 是否已通过审核（WXR comment_approved / Typecho status）。 */
  approved: boolean;
}

/** 导出 XML 的输入。 */
export interface ExportPayload {
  siteName: string;
  /** 站点根地址（绝对地址，不带结尾斜杠）。 */
  siteUrl: string;
  siteDescription?: string;
  /** 站点语言，例如 zh-CN / en。 */
  language?: string;
  /** 导出操作者名称，写入 WXR 的 wp:author 与 dc:creator 兜底。 */
  authorName?: string;
  /** 站内媒体相对地址改写成绝对地址时使用的 origin。 */
  origin: string;
  items: IoContent[];
  comments: IoComment[];
  /** 文件生成时间；单测可固定。 */
  generatedAt?: Date;
}

/** 解析后的一条内容。 */
export interface ParsedPost {
  /** 源文件里的文章标识（WXR post_id / Typecho cid），用于挂评论。 */
  sourceId: string;
  kind: ContentKind;
  title: string;
  slug: string;
  summary?: string;
  /** 正文；WXR 是 HTML，Typecho 可能是 Markdown 或 HTML。 */
  body: string;
  source_format: SourceFormat;
  /** 源文件里是否是已发布状态。 */
  published: boolean;
  published_at?: string;
  created_at?: string;
  updated_at?: string;
  categories: string[];
  tags: string[];
  author?: string;
}

/** 解析后的一条评论。 */
export interface ParsedComment {
  /** 所属内容的 sourceId。 */
  postSourceId: string;
  id: string;
  parentId?: string;
  author: string;
  body: string;
  created_at?: string;
  approved: boolean;
}

/** 解析时发现的、值得在预览里提示的问题。 */
export interface ImportWarning {
  code:
    | 'unsupported_post_type'
    | 'empty_title'
    | 'empty_body'
    | 'empty_comment'
    | 'orphan_comment'
    | 'invalid_date'
    | 'missing_wxr_version';
  /** 触发提示的原始类型或值（例如 attachment）。 */
  detail?: string;
  /** 合并后的出现次数。 */
  count?: number;
}

/** 一份可导入的文件。 */
export interface ParsedImport {
  format: ImportFormat;
  title?: string;
  url?: string;
  description?: string;
  posts: ParsedPost[];
  comments: ParsedComment[];
  warnings: ImportWarning[];
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const WXR_NAMESPACES = [
  'xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
  'xmlns:content="http://purl.org/rss/1.0/modules/content/"',
  'xmlns:wfw="http://wellformedweb.org/CommentAPI/"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:wp="http://wordpress.org/export/1.2/"',
].join(' ');

/* ------------------------------ XML 基础工具 ------------------------------ */

/** XML 1.0 不允许的控制字符；其余字符原样保留。 */
function stripInvalidXmlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 转义为可放进文本节点或属性值的字符串。 */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 转义为 CDATA 段；正文里出现 `]]>` 时按 XML 规则切开。 */
export function cdata(value: string): string {
  const clean = stripInvalidXmlChars(value).split(']]>').join(']]]]><![CDATA[>');
  return `<![CDATA[${clean}]]>`;
}

function xmlText(value: string | undefined | null): string {
  return escapeXml(value ?? '');
}

function attr(value: string): string {
  return escapeXml(value);
}

/* ------------------------------- 日期工具 -------------------------------- */

/** RFC 1123 时间（WXR 的 pubDate）。 */
export function formatRfc1123(date: Date): string {
  return date.toUTCString();
}

/** WordPress 的自定义字段时间是 UTC 的 `YYYY-MM-DD HH:MM:SS`。 */
export function formatWpDate(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** Typecho 数据库里 created / modified 是 Unix 秒。 */
export function formatTypechoDate(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

function asDate(value: string | undefined | null): Date | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstDate(...values: (string | undefined | null)[]): Date {
  for (const value of values) {
    const date = asDate(value);
    if (date) return date;
  }
  return new Date(0);
}

/**
 * 解析源文件里的时间。
 *
 * 支持 ISO 时间、WXR 的 `YYYY-MM-DD HH:MM:SS`（按 UTC 处理）以及 Typecho 的 Unix
 * 秒 / 毫秒时间戳；无法解析时返回 null。
 */
export function parseDateValue(value: string | undefined | null): Date | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/^\d{9,13}$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    const date = new Date(raw.length <= 10 ? num * 1000 : num);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ------------------------------- slug 工具 ------------------------------- */

/**
 * 把任意标题/路径规范成后端接受的 slug（小写字母、数字、连字符）。
 * 中文等非拉丁字符会被丢弃；结果为空表示「交给服务端自己生成」。
 */
export function normalizeSlug(raw: string | undefined | null): string {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    .replace(/-+$/g, '');
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(cleaned) ? cleaned : '';
}

/**
 * 在已占用的 slug 集合里取一个唯一值：冲突时追加 `-2`、`-3`……
 * 传入空字符串时返回空串且不占用集合。
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!base) return '';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  const slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/* ------------------------------ 媒体地址改写 ------------------------------ */

function absolutizeCandidate(value: string, origin: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return value;
  return `${origin}${trimmed}`;
}

/**
 * 把正文里的站内媒体地址改写成绝对地址。
 *
 * 只处理媒体属性（src / srcset / poster）与 Markdown 图片语法，避免误改站内链接；
 * XML 无法携带二进制，WordPress / Typecho 导入后需要按这些地址抓取或重新上传。
 */
export function absolutizeMediaUrls(input: string, origin: string): string {
  const base = (origin || '').replace(/\/+$/, '');
  if (!input || !base) return input;

  // Markdown 图片：![alt](/api/v1/media/x) → ![alt](https://host/api/v1/media/x)
  const withMarkdown = input.replace(
    /(!\[[^\]]*\]\()(\/(?!\/)[^)\s]+)(\))/g,
    (_match, start: string, url: string, end: string) => `${start}${base}${url}${end}`,
  );

  return withMarkdown.replace(
    /\b(src|poster|srcset)\s*=\s*("|')([^"']*)\2/gi,
    (_match, name: string, quote: string, value: string) => {
      const next =
        name.toLowerCase() === 'srcset'
          ? value
              .split(',')
              .map((part) => {
                const candidate = part.match(/^(\s*)(\S+)(.*)$/);
                if (!candidate) return part;
                return `${candidate[1]}${absolutizeCandidate(candidate[2], base)}${candidate[3]}`;
              })
              .join(',')
          : absolutizeCandidate(value, base);
      return `${name}=${quote}${next}${quote}`;
    },
  );
}

/* ------------------------------- 导出：WXR ------------------------------- */

function contentPath(kind: ContentKind, id: string): string {
  return `/${kind === 'article' ? 'a' : 'p'}/${encodeURIComponent(id)}`;
}

function wxrStatus(status: string): string {
  if (status === 'published') return 'publish';
  if (status === 'pending_review' || status === 'pending_security_check') return 'pending';
  return 'draft';
}

/** 站内文章 → WordPress post；站内帖子 → WordPress page（解析时反向映射）。 */
function wxrPostType(kind: ContentKind): string {
  return kind === 'article' ? 'post' : 'page';
}

function authorLogin(name: string | undefined): string {
  return normalizeSlug(name) || 'admin';
}

/**
 * 分类 / 标签在 WXR 里的 nicename。
 *
 * WordPress 的 nicename 就是分类别名：拉丁字母走正常 slug，中文等无法转写的名称
 * 用稳定短哈希兜底，避免多个中文分类都得到同一个别名而被导入器合并。
 */
function termSlug(name: string): string {
  const ascii = normalizeSlug(name);
  if (ascii) return ascii;
  let hash = 5381;
  for (const char of name) hash = ((hash * 33) ^ (char.codePointAt(0) ?? 0)) >>> 0;
  return `term-${hash.toString(36)}`;
}

function commentAuthorName(name: string): string {
  return (name || '').trim() || 'guest';
}

/** 构造一份 WXR 1.2 XML。 */
export function buildWordPressWxr(payload: ExportPayload): string {
  const generatedAt = payload.generatedAt ?? new Date();
  const origin = (payload.siteUrl || payload.origin || '').replace(/\/+$/, '');
  const blogUrl = origin;
  const author = authorLogin(payload.authorName);

  // 评论 id 在整份文件里递增；父评论可能出现在任意顺序，先建映射。
  const commentIds = new Map<IoComment, number>();
  const commentById = new Map<string, IoComment>();
  let nextCommentId = 1;
  for (const comment of payload.comments) {
    commentIds.set(comment, nextCommentId);
    nextCommentId += 1;
    if (comment.id) commentById.set(comment.id, comment);
  }

  const items = payload.items.map((item, index) => {
    const postId = index + 1;
    const at = firstDate(item.published_at, item.created_at, item.updated_at);
    const modified = firstDate(item.updated_at, item.created_at, item.published_at);
    const html = absolutizeMediaUrls(item.html || item.source || '', origin);
    const summary = item.summary?.trim() ?? '';
    const lines: string[] = [];
    lines.push('  <item>');
    lines.push(`    <title>${xmlText(item.title)}</title>`);
    lines.push(`    <link>${xmlText(`${blogUrl}${contentPath(item.kind, item.id)}`)}</link>`);
    lines.push(`    <pubDate>${formatRfc1123(at)}</pubDate>`);
    lines.push(`    <dc:creator>${cdata(item.author?.trim() || payload.authorName || author)}</dc:creator>`);
    lines.push(`    <guid isPermaLink="false">${xmlText(`${blogUrl}${contentPath(item.kind, item.id)}`)}</guid>`);
    lines.push(`    <description>${cdata(summary)}</description>`);
    lines.push(`    <content:encoded>${cdata(html)}</content:encoded>`);
    lines.push(`    <excerpt:encoded>${cdata(summary)}</excerpt:encoded>`);
    lines.push(`    <wp:post_id>${postId}</wp:post_id>`);
    lines.push(`    <wp:post_date>${formatWpDate(at)}</wp:post_date>`);
    lines.push(`    <wp:post_date_gmt>${formatWpDate(at)}</wp:post_date_gmt>`);
    lines.push(`    <wp:post_modified>${formatWpDate(modified)}</wp:post_modified>`);
    lines.push(`    <wp:post_modified_gmt>${formatWpDate(modified)}</wp:post_modified_gmt>`);
    lines.push('    <wp:comment_status>open</wp:comment_status>');
    lines.push('    <wp:ping_status>closed</wp:ping_status>');
    lines.push(`    <wp:post_name>${xmlText(item.slug)}</wp:post_name>`);
    lines.push(`    <wp:status>${wxrStatus(item.status)}</wp:status>`);
    lines.push('    <wp:post_parent>0</wp:post_parent>');
    lines.push('    <wp:menu_order>0</wp:menu_order>');
    lines.push(`    <wp:post_type>${wxrPostType(item.kind)}</wp:post_type>`);
    lines.push('    <wp:post_password></wp:post_password>');
    lines.push('    <wp:is_sticky>0</wp:is_sticky>');
    if (item.category) {
      const slug = termSlug(item.category);
      lines.push(
        `    <category domain="category" nicename="${attr(slug)}">${cdata(item.category)}</category>`,
      );
    }
    for (const tag of item.tags ?? []) {
      const name = tag.trim();
      if (!name) continue;
      const slug = termSlug(name);
      lines.push(`    <category domain="post_tag" nicename="${attr(slug)}">${cdata(name)}</category>`);
    }
    lines.push('    <wp:postmeta>');
    lines.push('      <wp:meta_key>practacu_press_kind</wp:meta_key>');
    lines.push(`      <wp:meta_value>${xmlText(item.kind)}</wp:meta_value>`);
    lines.push('    </wp:postmeta>');
    for (const comment of payload.comments) {
      if (comment.content_id !== item.id) continue;
      const commentId = commentIds.get(comment) ?? 0;
      const parent = comment.parent_id ? commentById.get(comment.parent_id) : undefined;
      const parentId = parent ? commentIds.get(parent) ?? 0 : 0;
      const approved = comment.approved ? '1' : '0';
      const atComment = firstDate(comment.created_at);
      lines.push('    <wp:comment>');
      lines.push(`      <wp:comment_id>${commentId}</wp:comment_id>`);
      lines.push(`      <wp:comment_author>${cdata(commentAuthorName(comment.author))}</wp:comment_author>`);
      lines.push('      <wp:comment_author_email></wp:comment_author_email>');
      lines.push('      <wp:comment_author_url></wp:comment_author_url>');
      lines.push('      <wp:comment_author_IP></wp:comment_author_IP>');
      lines.push(`      <wp:comment_date>${formatWpDate(atComment)}</wp:comment_date>`);
      lines.push(`      <wp:comment_date_gmt>${formatWpDate(atComment)}</wp:comment_date_gmt>`);
      lines.push(`      <wp:comment_content>${cdata(comment.body)}</wp:comment_content>`);
      lines.push(`      <wp:comment_approved>${approved}</wp:comment_approved>`);
      lines.push('      <wp:comment_type></wp:comment_type>');
      lines.push(`      <wp:comment_parent>${parentId}</wp:comment_parent>`);
      lines.push('      <wp:comment_user_id>0</wp:comment_user_id>');
      lines.push('    </wp:comment>');
    }
    lines.push('  </item>');
    return lines.join('\n');
  });

  return [
    XML_DECL,
    `<rss version="2.0" ${WXR_NAMESPACES}>`,
    '  <channel>',
    `    <title>${xmlText(payload.siteName)}</title>`,
    `    <link>${xmlText(blogUrl)}</link>`,
    `    <description>${xmlText(payload.siteDescription ?? '')}</description>`,
    `    <pubDate>${formatRfc1123(generatedAt)}</pubDate>`,
    `    <language>${xmlText(payload.language || 'zh-CN')}</language>`,
    '    <wp:wxr_version>1.2</wp:wxr_version>',
    `    <wp:base_site_url>${xmlText(blogUrl)}</wp:base_site_url>`,
    `    <wp:base_blog_url>${xmlText(blogUrl)}</wp:base_blog_url>`,
    '    <wp:author>',
    '      <wp:author_id>1</wp:author_id>',
    `      <wp:author_login>${cdata(author)}</wp:author_login>`,
    '      <wp:author_email></wp:author_email>',
    `      <wp:author_display_name>${cdata(payload.authorName?.trim() || author)}</wp:author_display_name>`,
    '      <wp:author_first_name></wp:author_first_name>',
    '      <wp:author_last_name></wp:author_last_name>',
    '    </wp:author>',
    '    <generator>Practacu Press</generator>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/* ------------------------------ 导出：Typecho ----------------------------- */

function typechoStatus(status: string): string {
  if (status === 'published') return 'publish';
  if (status === 'pending_review' || status === 'pending_security_check') return 'waiting';
  return 'draft';
}

function typechoType(kind: ContentKind): string {
  // 对齐 WXR 映射：文章 = post，帖子 = page；
  // Typecho 的「文章」是博客正文，我们的长文放这里最合适。
  return kind === 'article' ? 'post' : 'page';
}

function typechoBody(item: IoContent): string {
  if (item.source_format === 'markdown' && item.source) return item.source;
  return item.html || item.source || '';
}

/** 构造一份 Typecho 备份风格 XML。 */
export function buildTypechoXml(payload: ExportPayload): string {
  const generatedAt = payload.generatedAt ?? new Date();
  const origin = (payload.siteUrl || payload.origin || '').replace(/\/+$/, '');
  const commentIds = new Map<IoComment, number>();
  let nextCommentId = 1;
  for (const comment of payload.comments) {
    commentIds.set(comment, nextCommentId);
    nextCommentId += 1;
  }

  const posts = payload.items.map((item, index) => {
    const cid = index + 1;
    const created = firstDate(item.created_at, item.published_at, item.updated_at);
    const modified = firstDate(item.updated_at, item.created_at, item.published_at);
    const lines: string[] = [];
    lines.push('    <post>');
    lines.push(`      <cid>${cid}</cid>`);
    lines.push(`      <title>${xmlText(item.title)}</title>`);
    lines.push(`      <slug>${xmlText(item.slug)}</slug>`);
    if (item.summary?.trim()) lines.push(`      <summary>${cdata(item.summary.trim())}</summary>`);
    lines.push(`      <created>${formatTypechoDate(created)}</created>`);
    lines.push(`      <modified>${formatTypechoDate(modified)}</modified>`);
    lines.push(`      <text>${cdata(absolutizeMediaUrls(typechoBody(item), origin))}</text>`);
    lines.push(`      <status>${typechoStatus(item.status)}</status>`);
    lines.push(`      <type>${typechoType(item.kind)}</type>`);
    lines.push(`      <sourceFormat>${xmlText(item.source_format)}</sourceFormat>`);
    lines.push('      <authorId>1</authorId>');
    lines.push(`      <author>${cdata(item.author?.trim() || payload.authorName || '')}</author>`);
    lines.push('      <categories>');
    if (item.category) lines.push(`        <category>${cdata(item.category)}</category>`);
    lines.push('      </categories>');
    lines.push('      <tags>');
    for (const tag of item.tags ?? []) {
      const name = tag.trim();
      if (name) lines.push(`        <tag>${cdata(name)}</tag>`);
    }
    lines.push('      </tags>');
    const comments = payload.comments.filter((comment) => comment.content_id === item.id);
    if (comments.length) {
      lines.push('      <comments>');
      for (const comment of comments) {
        const coid = commentIds.get(comment) ?? 0;
        const parent = comment.parent_id
          ? payload.comments.find((candidate) => candidate.id === comment.parent_id)
          : undefined;
        const parentId = parent ? commentIds.get(parent) ?? 0 : 0;
        const at = firstDate(comment.created_at);
        lines.push('        <comment>');
        lines.push(`          <coid>${coid}</coid>`);
        lines.push(`          <cid>${cid}</cid>`);
        lines.push(`          <parent>${parentId}</parent>`);
        lines.push(`          <author>${cdata(commentAuthorName(comment.author))}</author>`);
        lines.push('          <mail></mail>');
        lines.push('          <url></url>');
        lines.push(`          <text>${cdata(comment.body)}</text>`);
        lines.push(`          <created>${formatTypechoDate(at)}</created>`);
        lines.push(`          <status>${comment.approved ? 'approved' : 'waiting'}</status>`);
        lines.push('        </comment>');
      }
      lines.push('      </comments>');
    }
    lines.push('    </post>');
    return lines.join('\n');
  });

  return [
    XML_DECL,
    '<typecho version="1.2">',
    '  <site>',
    `    <title>${xmlText(payload.siteName)}</title>`,
    `    <url>${xmlText(origin)}</url>`,
    `    <description>${xmlText(payload.siteDescription ?? '')}</description>`,
    `    <language>${xmlText(payload.language || 'zh-CN')}</language>`,
    '    <generator>Practacu Press</generator>',
    `    <exportedAt>${xmlText(generatedAt.toISOString())}</exportedAt>`,
    '  </site>',
    '  <posts>',
    ...posts,
    '  </posts>',
    '</typecho>',
    '',
  ].join('\n');
}

/** 导出文件名：practacu-press-wordpress-20261114-1930.xml。 */
export function exportFilename(format: ImportFormat, at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}`;
  return `practacu-press-${format === 'wordpress-wxr' ? 'wordpress' : 'typecho'}-${stamp}.xml`;
}

/* --------------------------------- 解析 ---------------------------------- */

function stripBom(xml: string): string {
  return xml.replace(/^\uFEFF/, '');
}

/**
 * 把 CDATA 段换成等价的转义文本。
 *
 * 浏览器原生解析器与 happy-dom 对 CDATA 的支持不一致（happy-dom 的 XML 解析器会
 * 在 CDATA 处报错）；统一先规范化，正文内容与 `]]>` 拆分都保持不变，也让解析器
 * 不再依赖具体的 CDATA 实现。
 */
function normalizeCdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, body: string) => escapeXml(body));
}

function parseDocument(xml: string): Document {
  if (typeof DOMParser === 'undefined') throw new Error('invalid_xml');
  // 只检查 CDATA 之外的部分：正文里出现 <!DOCTYPE 这样的代码示例不应被当成 DTD。
  const withoutCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(withoutCdata)) throw new Error('unsafe_xml');
  const doc = new DOMParser().parseFromString(normalizeCdata(xml), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('invalid_xml');
  if (!doc.documentElement) throw new Error('invalid_xml');
  return doc;
}

function children(parent: Element | null | undefined): Element[] {
  if (!parent) return [];
  return Array.from(parent.children);
}

/** 按限定名（含命名空间前缀，例如 wp:post_id）找直接子元素。 */
function childByQName(parent: Element | null | undefined, qname: string): Element | null {
  for (const child of children(parent)) {
    if (child.nodeName === qname || child.tagName === qname) return child;
  }
  return null;
}

/** 按本地名找直接子元素；用于没有命名空间前缀的简化文件。 */
function childByLocalName(parent: Element | null | undefined, localName: string): Element | null {
  for (const child of children(parent)) {
    if (child.localName === localName) return child;
  }
  return null;
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').trim();
}

/** 带命名空间与不带命名空间两种写法都试一次。 */
function childText(parent: Element | null | undefined, qname: string): string {
  return textOf(childByQName(parent, qname)) || textOf(childByLocalName(parent, qname.split(':').pop() ?? qname));
}

function addWarning(
  warnings: ImportWarning[],
  code: ImportWarning['code'],
  detail?: string,
  count = 1,
): void {
  const existing = warnings.find((warning) => warning.code === code && warning.detail === detail);
  if (existing) existing.count = (existing.count ?? 1) + count;
  else warnings.push({ code, detail, count });
}

function looksLikeHtml(body: string): boolean {
  return /<\/?(?:p|div|h[1-6]|ul|ol|li|blockquote|pre|img|figure|table|br|strong|em|a)\b[^>]*>/i.test(
    body,
  );
}

/** 自动检测文件格式。 */
export function detectImportFormat(xml: string): DetectedFormat {
  const source = stripBom(xml);
  const head = source.slice(0, 8192);
  if (/<wp:wxr_version[\s>]/.test(head) || /wordpress\.org\/export\/1\.\d/i.test(head)) {
    return 'wordpress-wxr';
  }
  if (/<rss[\s>]/i.test(head) && /<wp:/i.test(head)) return 'wordpress-wxr';
  if (/<typecho[\s>]/i.test(head)) return 'typecho';
  return 'unknown';
}

/** 站内文章 ↔ WXR post；站内帖子 ↔ WXR page。 */
function kindFromMappedType(type: string): ContentKind | null {
  if (type === 'post') return 'article';
  if (type === 'page') return 'post';
  return null;
}

function parseWxrComments(
  item: Element,
  postSourceId: string,
  comments: ParsedComment[],
  warnings: ImportWarning[],
): void {
  for (const commentEl of children(item)) {
    if (commentEl.nodeName !== 'wp:comment' && commentEl.localName !== 'comment') continue;
    const body = childText(commentEl, 'wp:comment_content') || childText(commentEl, 'comment_content');
    if (!body) {
      addWarning(warnings, 'empty_comment');
      continue;
    }
    const parentRaw = childText(commentEl, 'wp:comment_parent');
    const approvedRaw = childText(commentEl, 'wp:comment_approved');
    const createdRaw =
      childText(commentEl, 'wp:comment_date_gmt') || childText(commentEl, 'wp:comment_date');
    const created = parseDateValue(createdRaw);
    if (createdRaw && !created) addWarning(warnings, 'invalid_date', createdRaw);
    comments.push({
      postSourceId,
      id: childText(commentEl, 'wp:comment_id') || `${postSourceId}-comment-${comments.length + 1}`,
      parentId: parentRaw && parentRaw !== '0' ? parentRaw : undefined,
      author: childText(commentEl, 'wp:comment_author'),
      body,
      created_at: created?.toISOString(),
      approved: approvedRaw === '1' || approvedRaw === 'approve' || approvedRaw === 'approved',
    });
  }
}

/** 解析 WordPress WXR XML。 */
export function parseWordPressWxr(xml: string): ParsedImport {
  const doc = parseDocument(stripBom(xml));
  const warnings: ImportWarning[] = [];
  const channel = doc.getElementsByTagName('channel')[0] ?? doc.documentElement;
  if (!childText(channel, 'wp:wxr_version')) {
    addWarning(warnings, 'missing_wxr_version');
  }

  const posts: ParsedPost[] = [];
  const comments: ParsedComment[] = [];

  for (const [index, item] of Array.from(doc.getElementsByTagName('item')).entries()) {
    const postType = childText(item, 'wp:post_type');
    const mappedKind = kindFromMappedType(postType);
    if (!mappedKind) {
      addWarning(warnings, 'unsupported_post_type', postType || 'unknown');
      continue;
    }
    const sourceId = childText(item, 'wp:post_id') || `wxr-${index + 1}`;
    const title = childText(item, 'title');
    if (!title) addWarning(warnings, 'empty_title');
    const encoded = childByQName(item, 'content:encoded');
    let body = encoded ? (encoded.textContent ?? '') : '';
    if (!body.trim()) body = childText(item, 'description');
    body = body.trim();
    if (!body) addWarning(warnings, 'empty_body');

    let kind = mappedKind;
    for (const meta of children(item)) {
      if (meta.localName !== 'postmeta') continue;
      const key = childText(meta, 'wp:meta_key') || childText(meta, 'meta_key');
      const value = childText(meta, 'wp:meta_value') || childText(meta, 'meta_value');
      if (key === 'practacu_press_kind' && (value === 'article' || value === 'post')) {
        kind = value;
      }
    }

    const categories: string[] = [];
    const tags: string[] = [];
    for (const category of children(item)) {
      if (category.localName !== 'category' && category.nodeName !== 'category') continue;
      const name = (category.textContent ?? '').trim();
      if (!name) continue;
      if (category.getAttribute('domain') === 'post_tag') tags.push(name);
      else categories.push(name);
    }

    const publishedRaw = childText(item, 'wp:post_date_gmt') || childText(item, 'wp:post_date');
    const publishedAt = parseDateValue(
      publishedRaw === '0000-00-00 00:00:00' ? '' : publishedRaw,
    );
    if (publishedRaw && !publishedAt) addWarning(warnings, 'invalid_date', publishedRaw);
    const updatedRaw = childText(item, 'wp:post_modified_gmt') || childText(item, 'wp:post_modified');
    const updatedAt = parseDateValue(updatedRaw);
    const summary =
      (childByQName(item, 'excerpt:encoded')?.textContent ?? '').trim() ||
      childText(item, 'description') ||
      undefined;

    posts.push({
      sourceId,
      kind,
      title,
      slug: childText(item, 'wp:post_name'),
      summary: summary || undefined,
      body,
      source_format: 'html',
      published: childText(item, 'wp:status') === 'publish',
      published_at: publishedAt?.toISOString(),
      created_at: publishedAt?.toISOString(),
      updated_at: updatedAt?.toISOString(),
      categories,
      tags,
      author: childText(item, 'dc:creator') || undefined,
    });

    parseWxrComments(item, sourceId, comments, warnings);
  }

  return {
    format: 'wordpress-wxr',
    title: childText(channel, 'title') || undefined,
    url: childText(channel, 'link') || undefined,
    description: childText(channel, 'description') || undefined,
    posts,
    comments,
    warnings,
  };
}

function typechoCategories(postEl: Element): string[] {
  const box = childByQName(postEl, 'categories') ?? childByLocalName(postEl, 'categories');
  const values = children(box).filter((child) => child.localName === 'category');
  if (values.length) return values.map((child) => (child.textContent ?? '').trim()).filter(Boolean);
  return children(postEl)
    .filter((child) => child.localName === 'category')
    .map((child) => (child.textContent ?? '').trim())
    .filter(Boolean);
}

function typechoTags(postEl: Element): string[] {
  const box = childByQName(postEl, 'tags') ?? childByLocalName(postEl, 'tags');
  const values = children(box).filter((child) => child.localName === 'tag');
  if (values.length) return values.map((child) => (child.textContent ?? '').trim()).filter(Boolean);
  return children(postEl)
    .filter((child) => child.localName === 'tag')
    .map((child) => (child.textContent ?? '').trim())
    .filter(Boolean);
}

/** 解析 Typecho 备份风格 XML。 */
export function parseTypechoXml(xml: string): ParsedImport {
  const doc = parseDocument(stripBom(xml));
  const root = doc.documentElement;
  const warnings: ImportWarning[] = [];
  const site = childByQName(root, 'site') ?? childByLocalName(root, 'site');
  const postsBox = childByQName(root, 'posts') ?? childByLocalName(root, 'posts');
  const contentsBox = childByQName(root, 'contents') ?? childByLocalName(root, 'contents');
  const container = postsBox ?? contentsBox ?? root;
  const postElements = children(container).filter(
    (child) => child.localName === 'post' || child.localName === 'content',
  );

  const posts: ParsedPost[] = [];
  const comments: ParsedComment[] = [];
  const sourceIds = new Set<string>();

  for (const [index, postEl] of postElements.entries()) {
    const type = childText(postEl, 'type') || 'post';
    const mappedKind = kindFromMappedType(type);
    if (!mappedKind) {
      addWarning(warnings, 'unsupported_post_type', type);
      continue;
    }
    const sourceId = childText(postEl, 'cid') || `typecho-${index + 1}`;
    const title = childText(postEl, 'title');
    if (!title) addWarning(warnings, 'empty_title');
    const body = childText(postEl, 'text');
    if (!body) addWarning(warnings, 'empty_body');
    const sourceFormatRaw = childText(postEl, 'sourceFormat');
    const source_format: SourceFormat =
      sourceFormatRaw === 'markdown' || sourceFormatRaw === 'html' || sourceFormatRaw === 'plain'
        ? sourceFormatRaw
        : looksLikeHtml(body)
          ? 'html'
          : 'markdown';

    const createdRaw = childText(postEl, 'created');
    const modifiedRaw = childText(postEl, 'modified');
    const created = parseDateValue(createdRaw);
    if (createdRaw && !created) addWarning(warnings, 'invalid_date', createdRaw);
    const modified = parseDateValue(modifiedRaw);

    posts.push({
      sourceId,
      kind: mappedKind,
      title,
      slug: childText(postEl, 'slug'),
      summary: childText(postEl, 'summary') || undefined,
      body,
      source_format,
      published: childText(postEl, 'status') === 'publish',
      published_at: created?.toISOString(),
      created_at: created?.toISOString(),
      updated_at: modified?.toISOString(),
      categories: typechoCategories(postEl),
      tags: typechoTags(postEl),
      author: childText(postEl, 'author') || undefined,
    });
    sourceIds.add(sourceId);

    const commentsBox = childByQName(postEl, 'comments') ?? childByLocalName(postEl, 'comments');
    for (const commentEl of children(commentsBox)) {
      if (commentEl.localName !== 'comment') continue;
      const commentBody = childText(commentEl, 'text');
      if (!commentBody) {
        addWarning(warnings, 'empty_comment');
        continue;
      }
      const createdRawComment = childText(commentEl, 'created');
      const createdComment = parseDateValue(createdRawComment);
      if (createdRawComment && !createdComment) {
        addWarning(warnings, 'invalid_date', createdRawComment);
      }
      const parentRaw = childText(commentEl, 'parent');
      const statusRaw = childText(commentEl, 'status');
      comments.push({
        postSourceId: sourceId,
        id: childText(commentEl, 'coid') || `${sourceId}-comment-${comments.length + 1}`,
        parentId: parentRaw && parentRaw !== '0' ? parentRaw : undefined,
        author: childText(commentEl, 'author'),
        body: commentBody,
        created_at: createdComment?.toISOString(),
        approved: statusRaw === 'approved',
      });
    }
  }

  // 兼容把评论统一放在根节点、用 cid 关联文章的文件。
  const rootComments = childByQName(root, 'comments') ?? childByLocalName(root, 'comments');
  for (const commentEl of children(rootComments)) {
    if (commentEl.localName !== 'comment') continue;
    const postSourceId = childText(commentEl, 'cid');
    if (!postSourceId || !sourceIds.has(postSourceId)) {
      addWarning(warnings, 'orphan_comment');
      continue;
    }
    const commentBody = childText(commentEl, 'text');
    if (!commentBody) {
      addWarning(warnings, 'empty_comment');
      continue;
    }
    const parentRaw = childText(commentEl, 'parent');
    const created = parseDateValue(childText(commentEl, 'created'));
    comments.push({
      postSourceId,
      id: childText(commentEl, 'coid') || `root-comment-${comments.length + 1}`,
      parentId: parentRaw && parentRaw !== '0' ? parentRaw : undefined,
      author: childText(commentEl, 'author'),
      body: commentBody,
      created_at: created?.toISOString(),
      approved: childText(commentEl, 'status') === 'approved',
    });
  }

  return {
    format: 'typecho',
    title: childText(site, 'title') || undefined,
    url: childText(site, 'url') || undefined,
    description: childText(site, 'description') || undefined,
    posts,
    comments,
    warnings,
  };
}

/**
 * 解析上传的 XML：先识别格式，再交给对应的解析器。
 *
 * 抛出的错误码：`unknown_format`（不是 WXR / Typecho）、`invalid_xml`（XML 语法错误）、
 * `unsafe_xml`（含 DOCTYPE / ENTITY 声明）。页面负责翻译成用户可读的提示。
 */
export function parseImportXml(xml: string): ParsedImport {
  const source = stripBom(xml);
  const format = detectImportFormat(source);
  if (format === 'unknown') throw new Error('unknown_format');
  if (format === 'wordpress-wxr') return parseWordPressWxr(source);
  return parseTypechoXml(source);
}
