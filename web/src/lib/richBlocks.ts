/**
 * 富文本区块的 HTML 片段。
 *
 * 这段代码是编辑器的「唯一真相」：工具栏插入的 HTML 必须只用进程内安全检查白名单里的
 * 标签（a / blockquote / br / em / h1-h6 / hr / i / img / p / strong / table / td / th / tr），
 * 这样同一份内容在演示模式（前端渲染）和真实环境（服务端清洗后渲染）里长得一样。
 *
 * 不能用 div / span / figure / video / iframe：白名单会丢掉它们，只留文字。
 */

import { t } from './i18n';
import { escapeHtml } from './markdown';
import { liveCatalog } from './i18n/live';

export interface RichIcon {
  id: string;
  label: string;
  glyph: string;
}

/**
 * 图标用字符 + CSS 呈现，避免额外图标字体与图片请求。
 *
 * `label` 是图标选择器里的界面文案，所以走 `t()`；下面各个区块构造函数里的示例
 * 文字（「小标题」「正文段落。」这类）会被插进稿件、随内容存盘，属于内容而不是
 * 界面文案，因此保持原文，不在这里翻译。
 */
const RAW_RICH_ICONS: RichIcon[] = [
  { id: 'star', label: t('星标'), glyph: '★' },
  { id: 'spark', label: t('灵感'), glyph: '✦' },
  { id: 'leaf', label: t('叶子'), glyph: '❧' },
  { id: 'bulb', label: t('想法'), glyph: '☀' },
  { id: 'pin', label: t('地点'), glyph: '⌖' },
  { id: 'clock', label: t('时间'), glyph: '◷' },
  { id: 'heart', label: t('喜欢'), glyph: '♡' },
  { id: 'check', label: t('完成'), glyph: '✓' },
  { id: 'warn', label: t('注意'), glyph: '!' },
  { id: 'book', label: t('阅读'), glyph: '❏' },
  { id: 'pen', label: t('写作'), glyph: '✎' },
  { id: 'globe', label: t('网址'), glyph: '⊕' },
  { id: 'mail', label: t('邮件'), glyph: '✉' },
  { id: 'code', label: t('代码'), glyph: '⌘' },
  { id: 'chart', label: t('数据'), glyph: '▤' },
  { id: 'quote', label: t('引文'), glyph: '❝' },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const RICH_ICONS = liveCatalog(RAW_RICH_ICONS);

export function iconGlyph(id: string): string {
  return RICH_ICONS.find((icon) => icon.id === id)?.glyph ?? '•';
}

export function headingBlock(level: 2 | 3 | 4, text = '小标题'): string {
  return `<h${level}>${text}</h${level}>`;
}

export function paragraphBlock(text = '正文段落。'): string {
  return `<p>${text}</p>`;
}

/** 分栏：用表格承担布局，样式里把表格变成网格（白名单允许 table）。 */
export function columnsBlock(count: 2 | 3, texts: string[] = []): string {
  const cells = Array.from({ length: count }, (_, index) => {
    const body = texts[index] ?? `第 ${index + 1} 栏的内容。`;
    return `      <td>\n        <p>${body}</p>\n      </td>`;
  }).join('\n');
  return `<table class="pp-columns">\n  <tbody>\n    <tr>\n${cells}\n    </tr>\n  </tbody>\n</table>`;
}

export interface ImageInput {
  src: string;
  alt?: string;
  caption?: string;
  href?: string;
}

export function imageBlock({ src, alt = '', caption = '', href = '' }: ImageInput): string {
  const img = `<img src="${src}" alt="${alt}" />`;
  const body = href ? `<a href="${href}">${img}</a>` : img;
  if (!caption) return `<p class="pp-image">${body}</p>`;
  return `<p class="pp-image">${body}</p>\n<p class="pp-caption">${caption}</p>`;
}

export interface VideoInput {
  url: string;
  title?: string;
  poster?: string;
  provider?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** 从常见平台链接里推出封面；推不出来时交给 CSS 画一个播放占位。 */
export function posterFor(url: string): string {
  const youtube = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (youtube) return `https://i.ytimg.com/vi/${youtube[1]}/hqdefault.jpg`;
  return '';
}

/**
 * 视频卡片。
 *
 * 正文不允许 iframe，所以视频以「封面 + 标题 + 平台」的卡片呈现，点击到原站播放。
 * 这是有意的取舍：站内嵌播放需要一个可被信任的 iframe 白名单，v0.1 不做。
 */
export function videoBlock({ url, title = '', poster = '', provider = '' }: VideoInput): string {
  const href = escapeHtml(url.trim());
  const cover = escapeHtml((poster || posterFor(url)).trim());
  const name = escapeHtml(provider || hostOf(url));
  const label = escapeHtml(title.trim() || '视频标题');
  const img = cover
    ? `<img class="pp-video-poster" src="${cover}" alt="${escapeHtml(title || '视频封面')}" loading="lazy" />`
    : '';
  const cardClass = cover ? 'pp-video' : 'pp-video pp-video-plain';
  return `<a class="${cardClass}" href="${href}">\n  ${img}\n  <strong>${label}</strong>\n  <br />\n  <em>${name} · 点击播放</em>\n</a>`;
}

export interface EmbedInput {
  url: string;
  title?: string;
  description?: string;
}

export function embedBlock({ url, title = '', description = '' }: EmbedInput): string {
  const note = escapeHtml(description || hostOf(url));
  return `<a class="pp-embed" href="${escapeHtml(url.trim())}">\n  <strong>${escapeHtml(
    title.trim() || '链接标题',
  )}</strong>\n  <br />\n  <em>${note}</em>\n</a>`;
}

export function linkInline(href: string, text = '链接文字'): string {
  return `<a href="${escapeHtml(href.trim())}">${escapeHtml(text)}</a>`;
}

export interface LinkCardInput {
  url: string;
  title?: string;
  description?: string;
  cover?: string;
}

/**
 * 卡片链接。
 *
 * 白名单只允许 a / img / strong / em / br，所以卡片结构很朴素：
 * 封面图 + 标题 + 「域名 · 说明」一行。字段全部先转义；封面为空时加
 * `pp-linkcard-plain`，由 CSS 用伪元素画占位，不引入新标签。
 */
export function linkCardBlock({
  url,
  title = '',
  description = '',
  cover = '',
}: LinkCardInput): string {
  const href = url.trim();
  const domain = hostOf(href);
  const label = title.trim() || domain || '链接';
  const summary = description.trim();
  const note = summary ? `${domain} · ${summary}` : domain;
  const picture = cover.trim()
    ? `<img class="pp-linkcard-cover" src="${escapeHtml(cover.trim())}" alt="" />`
    : '';
  const className = cover.trim() ? 'pp-linkcard' : 'pp-linkcard pp-linkcard-plain';
  return `<a class="${className}" href="${escapeHtml(href)}">${picture}<strong>${escapeHtml(
    label,
  )}</strong><br /><em>${escapeHtml(note)}</em></a>`;
}


export interface TableInput {
  rows: number;
  cols: number;
  header: boolean;
}

export function tableBlock({ rows, cols, header }: TableInput): string {
  const count = Math.max(1, Math.min(8, cols));
  const width = Math.max(1, Math.min(20, rows));
  const head = header
    ? `  <thead>\n    <tr>${Array.from({ length: count }, (_, i) => `<th>列 ${i + 1}</th>`).join('')}</tr>\n  </thead>\n`
    : '';
  const body = Array.from({ length: width }, (_, row) => {
    const cells = Array.from({ length: count }, (_, col) => `<td>${row === 0 && !header ? `列 ${col + 1}` : '　'}</td>`).join('');
    return `    <tr>${cells}</tr>`;
  }).join('\n');
  return `<table class="pp-table">\n${head}  <tbody>\n${body}\n  </tbody>\n</table>`;
}

export function iconBlock(id: string, label = ''): string {
  const icon = `<i class="pp-icon pp-icon-${id}"></i>`;
  return label ? `<p class="pp-icon-line">${icon} ${label}</p>` : `<p class="pp-icon-line">${icon}</p>`;
}

export function noteBlock(tone: 'info' | 'warn' | 'ok' = 'info', title = '提示', body = '要补充的说明。'): string {
  return `<blockquote class="pp-note pp-note-${tone}">\n  <strong>${title}</strong>\n  <br />\n  ${body}\n</blockquote>`;
}

export function quoteBlock(text = '引用的句子。'): string {
  return `<blockquote>\n  <p>${text}</p>\n</blockquote>`;
}

export function dividerBlock(): string {
  return '<hr />';
}

export function codeBlock(lang = '', code = '在这里写代码'): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

export function galleryBlock(count: 3, images: string[] = []): string {
  const cells = Array.from({ length: count }, (_, index) => {
    const src = images[index] ?? '';
    const img = src ? `<img src="${src}" alt="" />` : '<p class="pp-gallery-empty">选择图片</p>';
    return `      <td>${img}</td>`;
  }).join('\n');
  return `<table class="pp-gallery">\n  <tbody>\n    <tr>\n${cells}\n    </tr>\n  </tbody>\n</table>`;
}
