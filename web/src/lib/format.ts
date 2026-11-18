import type {
  ContentStatus,
  ContentKind,
  PublishMode,
  Role,
  VisibilityMode,
  ContentAction,
  ActivityEntry,
} from '../types';
import { getLocale, t, type Locale } from './i18n';
import { labelMap } from './i18n/labels';

/**
 * 日期格式按语言固定，不用 `navigator.language`：站点语言才是事实来源，
 * 否则英文站点在中文系统上会显示中文日期。
 */
const DATE_FMT: Record<Locale, Intl.DateTimeFormat> = {
  'zh-CN': new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }),
  en: new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }),
};

const DATE_TIME_FMT: Record<Locale, Intl.DateTimeFormat> = {
  'zh-CN': new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }),
  en: new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }),
};

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const text = DATE_FMT[getLocale()].format(d);
  // 中文保持「2026.01.02」的旧样式；英文是「Jan 2, 2026」，不该被替换。
  return getLocale() === 'zh-CN' ? text.replace(/\//g, '.') : text;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const text = DATE_TIME_FMT[getLocale()].format(d);
  return getLocale() === 'zh-CN' ? text.replace(/\//g, '.') : text;
}

export function relativeTime(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('刚刚');
  if (diff < hour) return t('{count} 分钟前', { count: Math.floor(diff / minute) });
  if (diff < day) return t('{count} 小时前', { count: Math.floor(diff / hour) });
  if (diff < 7 * day) return t('{count} 天前', { count: Math.floor(diff / day) });
  return formatDate(iso);
}

/** 内容卡片用的相对时间：超过一周按月 / 年算，和常见博客一致。 */
export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('刚刚');
  if (diff < hour) return t('{count} 分钟前', { count: Math.floor(diff / minute) });
  if (diff < day) return t('{count} 小时前', { count: Math.floor(diff / hour) });
  if (diff < 30 * day) return t('{count} 天前', { count: Math.floor(diff / day) });
  const months = Math.floor(diff / (30 * day));
  if (months < 12) return t('{count} 个月前', { count: months });
  return t('{count} 年前', { count: Math.floor(months / 12) });
}

/**
 * 文章图表存的是 `pp-diagram` 围栏 + JSON 规格，不是正文。
 * 字数与摘要都不要把这段 JSON 当成文字，先把整块去掉。
 */
const DIAGRAM_BLOCK = /<pre><code[^>]*language-pp-diagram[^>]*>[\s\S]*?<\/code><\/pre>/gi;

function withoutDiagramBlocks(html: string): string {
  return html.replace(DIAGRAM_BLOCK, ' ');
}

export function readingTime(html: string): number {
  const text = withoutDiagramBlocks(html).replace(/<[^>]+>/g, '');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = text.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

export function excerpt(html: string, max = 120): string {
  const text = withoutDiagramBlocks(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function initials(name?: string): string {
  if (!name) return '·';
  const trimmed = name.trim();
  if (!trimmed) return '·';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase();
}

export function shortId(id?: string): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export const ROLE_LABEL = labelMap<Role>({
  platform_admin: '平台管理员',
  site_admin: '站点管理员',
  editor: '编辑 / 审核员',
  member: '成员',
});

export const ROLE_HINT = labelMap<Role>({
  platform_admin: '管理平台账户、站点与全局安全策略',
  site_admin: '管理本站点成员、内容规则、主题与存储',
  editor: '审核文章、帖子、评论与举报，可直接发布',
  member: '发布文章与帖子、评论、互动',
});

export const STATUS_LABEL = labelMap<ContentStatus>({
  draft: '草稿',
  pending_review: '待审核',
  published: '已发布',
  rejected: '已退回',
  archived: '已归档',
  pending_security_check: '安全检查中',
});

export const STATUS_TONE: Record<ContentStatus, 'neutral' | 'warn' | 'ok' | 'danger' | 'muted'> = {
  draft: 'muted',
  pending_review: 'warn',
  published: 'ok',
  rejected: 'danger',
  archived: 'neutral',
  pending_security_check: 'neutral',
};

export const KIND_LABEL = labelMap<ContentKind>({
  article: '文章',
  post: '帖子',
});

export const VISIBILITY_LABEL = labelMap<VisibilityMode>({
  public: '公开浏览',
  members_only: '登录后浏览',
});

export const PUBLISH_LABEL = labelMap<PublishMode>({
  open: '开放发布',
  review: '审核发布',
  role_based: '按角色发布',
});

export const ACTION_LABEL = labelMap<ContentAction>({
  submit: '提交审核',
  publish: '发布',
  reject: '退回',
  archive: '归档',
  restore: '恢复',
  'security-retry': '重试安全检查',
  undelete: '从回收站恢复',
  purge: '彻底删除',
  unpublish: '撤销发布',
});

export const ROLE_RANK: Record<Role, number> = {
  member: 0,
  editor: 1,
  site_admin: 2,
  platform_admin: 3,
};

export function canReview(role?: Role): boolean {
  return role === 'editor' || role === 'site_admin' || role === 'platform_admin';
}

export function isSiteAdmin(role?: Role): boolean {
  return role === 'site_admin' || role === 'platform_admin';
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function formatBytes(bytes: number): string {
  // 0 B, 负数、NaN 以及 0 < bytes < 1（log 为负，会让单位下标变成 -1）都收敛到 0；
  // 否则会拼出「512.0 undefined」这种值。
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function activityTone(action: string): 'neutral' | 'ok' | 'warn' | 'danger' {
  if (/发布|创建|完成|published|created|verified|restored|approved/.test(action)) return 'ok';
  if (/退回|删除|失败|rejected|deleted|removed|failed|banned/.test(action)) return 'danger';
  if (/提交|审核|修改|submitted|updated|changed|moderated|assigned/.test(action)) return 'warn';
  return 'neutral';
}

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function activityCsv(entries: ActivityEntry[]): string {
  const head = 'time,actor,action,target,detail';
  const rows = entries.map((e) =>
    [e.at, e.actor, e.action, e.target, e.detail ?? '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  );
  return [head, ...rows].join('\n');
}
