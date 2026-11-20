import type { IconName } from '../components/Icon';
import type { CapabilityId } from '../types';

/**
 * 后台功能索引：命令面板的第二层数据。
 *
 * 侧栏导航只覆盖“页面”，但每一页里还有大量具体功能（sitemap、CORS、S3、回收站、
 * 能力矩阵……）。这张表把这些细节功能逐条列出来，搜索时直接命中并跳到所在页面；
 * 标签一律写中文原文（`t()` 的键），由 AdminShell 翻译成当前语言。
 *
 * 维护规则：
 * - 只加真实存在、打开页面就能找到的功能，不要写宣传语；
 * - `requires` / `requiresAny` 与侧栏的权限保持一致，做不到的事不出现在结果里；
 * - 同一个功能只保留一条（页面入口已有导航项时不重复添加页面本身）；
 * - 新增条目必须同步 `components_AdminFeatureIndex.ts` 的英文，`adminFeatureIndex.test.ts`
 *   会逐条检查英文存在且不含中文。
 */

export type AdminFeatureRequirement = CapabilityId | 'platform_admin';

export interface AdminFeatureSeed {
  /** 稳定 id，用于列表 key 与测试定位。 */
  id: string;
  /** 目标路由；与导航项相同的页面会并排出现在结果里。 */
  to: string;
  /** 中文原文（i18n 键）。 */
  label: string;
  /** 结果列表分组，同样是中文原文。 */
  group: string;
  icon?: IconName;
  /** 额外搜索词：英文缩写、同义词，帮助“sitemap”“cors”这类查询命中。 */
  keywords?: string[];
  requires?: AdminFeatureRequirement;
  requiresAny?: AdminFeatureRequirement[];
}

export const ADMIN_FEATURE_INDEX: AdminFeatureSeed[] = [
  // ---- 概览 / 性能面板 ----
  { id: 'dashboard-overview', to: '/admin', label: '站点概览', group: '概览', icon: 'home', keywords: ['dashboard', '总览'] },
  { id: 'system-cpu', to: '/admin/ext/system', label: 'CPU 占用', group: '概览', icon: 'chart', keywords: ['cpu'], requires: 'platform_admin' },
  { id: 'system-memory', to: '/admin/ext/system', label: '内存占用', group: '概览', icon: 'chart', keywords: ['memory', 'ram'], requires: 'platform_admin' },
  { id: 'system-disk', to: '/admin/ext/system', label: '磁盘占用', group: '概览', icon: 'database', keywords: ['disk', 'storage'], requires: 'platform_admin' },
  { id: 'system-process', to: '/admin/ext/system', label: '进程列表', group: '概览', icon: 'server', keywords: ['process'], requires: 'platform_admin' },

  // ---- 内容 ----
  { id: 'content-published', to: '/admin/content', label: '已发布内容', group: '内容', icon: 'file', keywords: ['文章', '帖子', 'published'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'content-draft', to: '/admin/content', label: '草稿箱', group: '内容', icon: 'edit', keywords: ['draft'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'content-review', to: '/admin/content', label: '待审核内容', group: '内容', icon: 'shield', keywords: ['pending'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'content-trash', to: '/admin/content', label: '回收站', group: '内容', icon: 'trash', keywords: ['trash', '删除', '恢复'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'editor-article', to: '/admin/content/new/article', label: '写新稿', group: '内容', icon: 'edit', keywords: ['文章', 'new article'], requires: 'write_content' },
  { id: 'editor-post', to: '/admin/content/new/post', label: '新建帖子', group: '内容', icon: 'edit', keywords: ['post', '帖子'], requires: 'write_content' },
  { id: 'pages-list', to: '/admin/pages', label: '自定义页面', group: '内容', icon: 'layers', keywords: ['pages'], requires: 'manage_site' },
  { id: 'pages-new', to: '/admin/pages/new', label: '新建页面', group: '内容', icon: 'plus', keywords: ['new page'], requires: 'manage_site' },
  { id: 'taxonomy-category', to: '/admin/taxonomy', label: '分类管理', group: '内容', icon: 'list', keywords: ['category'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'taxonomy-tag', to: '/admin/taxonomy', label: '标签管理', group: '内容', icon: 'tag', keywords: ['tag'], requiresAny: ['write_content', 'moderate_content'] },
  { id: 'security-review', to: '/admin/security', label: '审核队列', group: '内容', icon: 'shield', keywords: ['review'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'security-comment', to: '/admin/security', label: '评论审核', group: '内容', icon: 'message', keywords: ['comment'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'security-report', to: '/admin/security', label: '举报处理', group: '内容', icon: 'alert', keywords: ['report'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'security-policy', to: '/admin/security', label: '审核与评论设置', group: '内容', icon: 'settings', keywords: ['moderation'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'security-words', to: '/admin/security', label: '敏感词', group: '内容', icon: 'shield', keywords: ['sensitive words'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'security-ip', to: '/admin/security', label: 'IP 访问规则', group: '内容', icon: 'lock', keywords: ['ip rule'], requiresAny: ['moderate_content', 'moderate_comment'] },
  { id: 'media-upload', to: '/admin/media', label: '上传媒体', group: '内容', icon: 'upload', keywords: ['upload'], requires: 'write_content' },
  { id: 'media-library', to: '/admin/media', label: '媒体库', group: '内容', icon: 'image', keywords: ['media'], requires: 'write_content' },
  { id: 'media-quota', to: '/admin/media', label: '媒体配额', group: '内容', icon: 'database', keywords: ['quota'], requires: 'write_content' },
  { id: 'redirects', to: '/admin/redirects', label: '永久链接规则', group: '内容', icon: 'link', keywords: ['permalink', 'redirect', '跳转'], requires: 'manage_site' },
  { id: 'theme-builder', to: '/admin/theme', label: '页面编排', group: '内容', icon: 'layers', keywords: ['page builder'], requires: 'manage_site' },
  { id: 'theme-builder-devices', to: '/admin/theme', label: '三端布局', group: '内容', icon: 'columns', keywords: ['responsive'], requires: 'manage_site' },
  { id: 'theme-builder-components', to: '/admin/theme', label: '页面组件', group: '内容', icon: 'grid', keywords: ['block', 'widget'], requires: 'manage_site' },

  // ---- 用户 ----
  { id: 'members-list', to: '/admin/users', label: '成员列表', group: '用户', icon: 'users', keywords: ['member'], requires: 'manage_member' },
  { id: 'member-create', to: '/admin/users', label: '创建账户', group: '用户', icon: 'plus', keywords: ['create account', '邀请'], requires: 'manage_member' },
  { id: 'member-role', to: '/admin/users', label: '角色调整', group: '用户', icon: 'shield', keywords: ['role'], requires: 'manage_member' },
  { id: 'member-quota', to: '/admin/users', label: '成员配额', group: '用户', icon: 'database', keywords: ['quota'], requires: 'manage_member' },
  { id: 'member-2fa', to: '/admin/users', label: '重置两步验证', group: '用户', icon: 'lock', keywords: ['2fa', 'two factor'], requires: 'manage_member' },
  { id: 'permissions-matrix', to: '/admin/permissions', label: '能力矩阵', group: '用户', icon: 'shield', keywords: ['permission', 'matrix'], requires: 'manage_permission' },
  { id: 'permissions-new', to: '/admin/permissions', label: '新建用户组', group: '用户', icon: 'plus', keywords: ['group'], requires: 'manage_permission' },
  { id: 'permissions-rename', to: '/admin/permissions', label: '重命名用户组', group: '用户', icon: 'edit', keywords: ['rename'], requires: 'manage_permission' },

  // ---- 主题设置 ----
  { id: 'themes-library', to: '/admin/themes/choose', label: '主题库', group: '主题设置', icon: 'grid', keywords: ['theme'], requires: 'manage_site' },
  { id: 'themes-import', to: '/admin/themes/choose', label: '导入主题', group: '主题设置', icon: 'upload', keywords: ['import theme', 'zip'], requires: 'manage_site' },
  { id: 'themes-export', to: '/admin/themes/choose', label: '导出主题', group: '主题设置', icon: 'download', keywords: ['export theme'], requires: 'manage_site' },
  { id: 'themes-new', to: '/admin/themes/choose', label: '新建主题', group: '主题设置', icon: 'plus', keywords: ['new theme'], requires: 'manage_site' },
  { id: 'themes-colors', to: '/admin/themes', label: '配色与版式', group: '主题设置', icon: 'palette', keywords: ['color', 'layout'], requires: 'manage_site' },
  { id: 'themes-nav', to: '/admin/themes', label: '导航与页脚', group: '主题设置', icon: 'menu', keywords: ['nav', 'footer'], requires: 'manage_site' },
  { id: 'themes-motion', to: '/admin/themes', label: '主题微调', group: '主题设置', icon: 'settings', keywords: ['motion', 'animation'], requires: 'manage_site' },
  { id: 'loading-animation', to: '/admin/loading', label: '加载动画', group: '主题设置', icon: 'refresh', keywords: ['loading'], requires: 'manage_site' },
  { id: 'loading-skeleton', to: '/admin/loading', label: '骨架屏', group: '主题设置', icon: 'layers', keywords: ['skeleton', 'shimmer'], requires: 'manage_site' },
  { id: 'extensions-list', to: '/admin/extensions', label: '扩展列表', group: '主题设置', icon: 'grid', keywords: ['plugin', 'extension'], requires: 'manage_site' },
  { id: 'extensions-install', to: '/admin/extensions', label: '导入扩展包', group: '主题设置', icon: 'upload', keywords: ['install plugin'], requires: 'manage_site' },
  { id: 'extensions-enable', to: '/admin/extensions', label: '启用扩展', group: '主题设置', icon: 'check', keywords: ['enable'], requires: 'manage_site' },

  // ---- 站点 ----
  { id: 'settings-basic', to: '/admin/settings', label: '站点名称与描述', group: '站点', icon: 'settings', keywords: ['site name'], requires: 'manage_site' },
  { id: 'settings-icon', to: '/admin/settings', label: '站点图标', group: '站点', icon: 'image', keywords: ['favicon', 'icon'], requires: 'manage_site' },
  { id: 'settings-language', to: '/admin/settings', label: '站点语言', group: '站点', icon: 'globe', keywords: ['language', 'i18n'], requires: 'manage_site' },
  { id: 'access-domain', to: '/admin/access', label: '主域名', group: '站点', icon: 'globe', keywords: ['domain'], requires: 'manage_site' },
  { id: 'access-alias', to: '/admin/access', label: '域名别名', group: '站点', icon: 'globe', keywords: ['alias'], requires: 'manage_site' },
  { id: 'access-ssl', to: '/admin/access', label: 'SSL 证书', group: '站点', icon: 'lock', keywords: ['https', 'tls', 'certificate'], requires: 'manage_site' },
  { id: 'access-cors', to: '/admin/access', label: 'CORS 来源', group: '站点', icon: 'shield', keywords: ['cors', 'origin'], requires: 'manage_site' },
  { id: 'access-cookie', to: '/admin/access', label: 'Cookie 作用域', group: '站点', icon: 'lock', keywords: ['cookie'], requires: 'manage_site' },
  { id: 'access-port', to: '/admin/access', label: '访问端口', group: '站点', icon: 'server', keywords: ['port'], requires: 'manage_site' },
  { id: 'access-proxy', to: '/admin/access', label: '可信代理', group: '站点', icon: 'server', keywords: ['proxy'], requires: 'manage_site' },
  { id: 'verification', to: '/admin/verification', label: '人机验证', group: '站点', icon: 'lock', keywords: ['captcha'], requires: 'manage_site' },
  { id: 'verification-local', to: '/admin/verification', label: '本地验证码', group: '站点', icon: 'image', keywords: ['local captcha'], requires: 'manage_site' },
  { id: 'seo-title', to: '/admin/seo', label: '标题模板', group: '站点', icon: 'search', keywords: ['title', 'seo'], requires: 'manage_site' },
  { id: 'seo-description', to: '/admin/seo', label: '描述与关键词', group: '站点', icon: 'search', keywords: ['description', 'keywords'], requires: 'manage_site' },
  { id: 'seo-canonical', to: '/admin/seo', label: 'canonical 链接', group: '站点', icon: 'link', keywords: ['canonical'], requires: 'manage_site' },
  { id: 'seo-social', to: '/admin/seo', label: 'Open Graph 与 Twitter', group: '站点', icon: 'external', keywords: ['og', 'twitter card'], requires: 'manage_site' },
  { id: 'seo-jsonld', to: '/admin/seo', label: 'JSON-LD 结构化数据', group: '站点', icon: 'code', keywords: ['json-ld', 'schema'], requires: 'manage_site' },
  { id: 'seo-sitemap', to: '/admin/seo', label: 'sitemap.xml', group: '站点', icon: 'file', keywords: ['sitemap'], requires: 'manage_site' },
  { id: 'seo-robots', to: '/admin/seo', label: 'robots.txt', group: '站点', icon: 'file', keywords: ['robots'], requires: 'manage_site' },
  { id: 'seo-noindex', to: '/admin/seo', label: '全站 noindex', group: '站点', icon: 'eye', keywords: ['noindex'], requires: 'manage_site' },
  { id: 'perf-first', to: '/admin/performance', label: '首屏优化', group: '站点', icon: 'refresh', keywords: ['performance', 'first screen'], requires: 'manage_site' },
  { id: 'perf-cache', to: '/admin/performance', label: '缓存与压缩', group: '站点', icon: 'database', keywords: ['cache', 'gzip'], requires: 'manage_site' },
  { id: 'perf-media', to: '/admin/performance', label: '媒体懒加载', group: '站点', icon: 'image', keywords: ['lazy load'], requires: 'manage_site' },
  { id: 'perf-timeout', to: '/admin/performance', label: '超时设置', group: '站点', icon: 'clock', keywords: ['timeout'], requires: 'manage_site' },
  { id: 'perf-pool', to: '/admin/performance', label: '数据库连接池', group: '站点', icon: 'database', keywords: ['connection pool'], requires: 'manage_site' },
  { id: 'perf-limit', to: '/admin/performance', label: '请求限流', group: '站点', icon: 'shield', keywords: ['rate limit'], requires: 'manage_site' },
  { id: 'storage', to: '/admin/storage', label: '存储策略', group: '站点', icon: 'database', keywords: ['storage'], requires: 'manage_site' },
  { id: 'storage-s3', to: '/admin/storage', label: 'S3 兼容存储', group: '站点', icon: 'database', keywords: ['s3', 'minio', 'aws'], requires: 'manage_site' },
  { id: 'storage-oss', to: '/admin/storage', label: '阿里云 OSS', group: '站点', icon: 'database', keywords: ['oss', 'aliyun'], requires: 'manage_site' },
  { id: 'storage-cos', to: '/admin/storage', label: '腾讯云 COS', group: '站点', icon: 'database', keywords: ['cos', 'tencent'], requires: 'manage_site' },
  { id: 'storage-upload', to: '/admin/storage', label: '上传大小上限', group: '站点', icon: 'upload', keywords: ['upload limit'], requires: 'manage_site' },
  { id: 'data-export', to: '/admin/data', label: '导出站点', group: '站点', icon: 'download', keywords: ['export'], requires: 'manage_site' },
  { id: 'data-import', to: '/admin/data', label: '导入站点', group: '站点', icon: 'upload', keywords: ['import'], requires: 'manage_site' },
  { id: 'data-backup', to: '/admin/data', label: '整库备份', group: '站点', icon: 'database', keywords: ['backup'], requires: 'manage_site' },
  { id: 'data-restore', to: '/admin/data', label: '恢复备份', group: '站点', icon: 'refresh', keywords: ['restore'], requires: 'manage_site' },
  { id: 'data-wordpress', to: '/admin/data', label: 'WordPress 导入', group: '站点', icon: 'download', keywords: ['wordpress', 'wxr'], requires: 'manage_site' },
  { id: 'data-typecho', to: '/admin/data', label: 'Typecho 导入', group: '站点', icon: 'download', keywords: ['typecho'], requires: 'manage_site' },
  { id: 'data-backup-schedule', to: '/admin/data', label: '自动备份计划', group: '站点', icon: 'database', keywords: ['backup schedule', '自动备份'], requires: 'platform_admin' },
  { id: 'login-methods', to: '/admin/login-settings', label: '登录方式', group: '站点', icon: 'lock', keywords: ['login', 'sign in'], requires: 'manage_site' },
  { id: 'login-email', to: '/admin/login-settings', label: '邮箱登录', group: '站点', icon: 'mail', keywords: ['email login'], requires: 'manage_site' },
  { id: 'login-sms', to: '/admin/login-settings', label: '短信登录', group: '站点', icon: 'message', keywords: ['sms'], requires: 'manage_site' },
  { id: 'login-oauth', to: '/admin/login-settings', label: '第三方登录', group: '站点', icon: 'lock', keywords: ['oauth', 'google', 'github'], requires: 'manage_site' },
  { id: 'login-mail', to: '/admin/login-settings', label: '邮件通知', group: '站点', icon: 'mail', keywords: ['smtp', 'email'], requires: 'manage_site' },
  { id: 'update-check', to: '/admin/update', label: '检查更新', group: '站点', icon: 'refresh', keywords: ['update'], requires: 'manage_site' },
  { id: 'update-channel', to: '/admin/update', label: '稳定版与测试版通道', group: '站点', icon: 'tag', keywords: ['stable', 'beta', 'channel'], requires: 'manage_site' },
  { id: 'newsletter', to: '/admin/newsletter', label: '订阅者', group: '站点', icon: 'mail', keywords: ['subscriber'], requires: 'manage_site' },
  { id: 'newsletter-template', to: '/admin/newsletter', label: '邮件模板', group: '站点', icon: 'mail', keywords: ['template'], requires: 'manage_site' },
  { id: 'newsletter-send', to: '/admin/newsletter', label: '群发邮件', group: '站点', icon: 'send', keywords: ['broadcast'], requires: 'manage_site' },
  { id: 'newsletter-log', to: '/admin/newsletter', label: '投递日志', group: '站点', icon: 'database', keywords: ['delivery log'], requires: 'manage_site' },
  { id: 'insights-traffic', to: '/admin?insights=1', label: '访问统计', group: '概览', icon: 'chart', keywords: ['analytics', 'traffic'], requires: 'view_log' },
  { id: 'insights-source', to: '/admin?insights=1', label: '来源分析', group: '概览', icon: 'globe', keywords: ['referrer', 'source'], requires: 'view_log' },
  { id: 'insights-device', to: '/admin?insights=1', label: '设备分布', group: '概览', icon: 'columns', keywords: ['device'], requires: 'view_log' },
  { id: 'insights-retention', to: '/admin?insights=1', label: '留存', group: '概览', icon: 'chart', keywords: ['retention'], requires: 'view_log' },
  { id: 'activity-log', to: '/admin/activity?source=audit', label: '操作日志', group: '系统', icon: 'clock', keywords: ['audit', 'activity'], requires: 'view_log' },
  { id: 'activity-request', to: '/admin/activity?source=request', label: '请求日志', group: '系统', icon: 'server', keywords: ['request log'], requires: 'view_log' },
  { id: 'activity-queue', to: '/admin/activity', label: '队列状态', group: '系统', icon: 'layers', keywords: ['queue', 'outbox'], requires: 'view_log' },
  { id: 'activity-uptime', to: '/admin/activity', label: '站点运行时长', group: '系统', icon: 'clock', keywords: ['uptime'], requires: 'view_log' },
  { id: 'docs', to: '/admin/docs', label: 'API 文档', group: '系统', icon: 'file', keywords: ['openapi', 'docs'], requires: 'manage_site' },

  // ---- 平台 ----
  { id: 'platform-sites', to: '/admin/platform', label: '站点平台', group: '系统', icon: 'server', keywords: ['platform', 'sites'], requires: 'platform_admin' },
  { id: 'platform-new', to: '/admin/platform/new', label: '新建站点', group: '系统', icon: 'plus', keywords: ['new site'], requires: 'platform_admin' },
  { id: 'platform-overview', to: '/admin/platform/overview', label: '平台总览', group: '系统', icon: 'grid', keywords: ['platform overview'], requires: 'platform_admin' },
  { id: 'platform-audit', to: '/admin/platform/audit', label: '跨站审计', group: '系统', icon: 'shield', keywords: ['cross site audit'], requires: 'platform_admin' },
  { id: 'platform-users', to: '/admin/platform/users', label: '平台用户', group: '系统', icon: 'users', keywords: ['platform accounts'], requires: 'platform_admin' },
];
