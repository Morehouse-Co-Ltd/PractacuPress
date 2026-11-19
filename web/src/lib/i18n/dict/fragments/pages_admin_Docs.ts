import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Docs.tsx` */
const fragment: Dictionary = {
  // ---- 页头 ----
  '调用接口': 'API access',
  '前端严格按 OpenAPI 0.1.0 实现；本页记录已接入的端点与仍在契约里的缺口。':
    'The front end follows OpenAPI 0.1.0 strictly; this page lists the endpoints already wired up and the gaps still left in the contract.',
  '演示模式': 'Demo mode',
  'API 参考': 'API reference',
  '演示模式 · 无远程 API': 'Demo mode · no remote API',

  // ---- 基础约定 ----
  '基础约定': 'Base conventions',
  '来自设计文档第 7 章与 OpenAPI 描述。':
    'Taken from chapter 7 of the design document and the OpenAPI description.',
  'API 根路径': 'API base path',
  '鉴权': 'Authentication',
  '错误体': 'Error body',
  '列表': 'List',
  '时间与枚举': 'Time and enums',
  'UTC ISO 8601 · 小写蛇形': 'UTC ISO 8601 · lowercase snake_case',
  'Problem 示例': 'Problem example',
  '当前用户没有执行此操作的权限': 'Your account is not allowed to do this.',
  '前端分支判断只依赖': 'Front-end branching reads only',
  '；': ';',
  '是本地化文案，可能变化。': 'is localized copy and may change.',

  // ---- 会话与实时 ----
  '会话与实时': 'Sessions and realtime',
  '安全边界与降级路径。': 'Security boundaries and fallback paths.',
  'Access Token 只保存在内存，刷新页面后通过 HttpOnly Refresh Cookie 重新获取；刷新时读取可读的':
    'The access token is kept in memory only; after a page reload it is fetched again with the HttpOnly refresh cookie. Refreshing also reads the readable',
  'Cookie 作为双提交令牌。刷新失败会清空本地会话并回到登录页。':
    'cookie as the double-submit token. A failed refresh clears the local session and returns to the sign-in page.',
  '实时事件使用文档 7.7 允许的轮询降级：每 45 秒刷新未读通知，窗口重新获得焦点时也会刷新。':
    'Realtime events use the polling fallback that chapter 7.7 of the document allows: unread notifications refresh every 45 seconds, and also when the window regains focus.',
  'WebSocket 票据端点已存在于契约，但本版没有启用长连接；消息页在打开会话时读取一次并按需刷新。':
    'The WebSocket ticket endpoint exists in the contract, but this version does not open a long-lived connection; the messages page reads once when a conversation is opened and refreshes on demand.',
  '前端不是安全边界': 'The front end is not a security boundary',
  '所有权限判断都在服务端。界面隐藏按钮、禁用表单只是体验优化，不能替代授权。':
    'Every permission check happens on the server. Hiding a button or disabling a form only improves the experience; it is no substitute for authorization.',

  // ---- 端点表 ----
  '认证': 'Authentication',
  '注册并建立会话': 'Register and start a session',
  '邮箱密码登录': 'Sign in with email and password',
  '轮换会话，需要 X-CSRF-Token': 'Rotate the session; needs X-CSRF-Token',
  '撤销当前会话': 'Revoke the current session',
  '当前用户、角色与站点': 'Current user, role, and site',
  '站点': 'Site',
  '成员读取站点': 'A member reads the site',
  '修改名称、域名与两种模式': 'Change the name, domain, and the two modes',
  '成员列表（站点管理员）': 'Member list (site admin)',
  '创建账户（站点管理员）': 'Create an account (site admin)',
  '调整角色': 'Change a role',
  '内容': 'Content',
  '游标分页列表': 'Cursor-paginated list',
  '读取单篇': 'Read a single item',
  '创建草稿，服务端清洗': 'Create a draft; the server sanitizes it',
  '编辑草稿': 'Edit a draft',
  '只搜索已发布内容': 'Searches published content only',
  '社区': 'Community',
  '评论列表（公开站点匿名可读，支持筛选与分页）':
    'Comment list (anonymous reading on public sites, with filters and paging)',
  '评论与回复': 'Comments and replies',
  '作者编辑正文 / 审核员切换可见性': 'The author edits the body / a reviewer toggles visibility',
  '作者或审核员删除': 'Deleted by the author or a reviewer',
  '点赞（幂等切换）': 'Reaction (idempotent toggle)',
  '收藏切换': 'Bookmark toggle',
  '关注切换': 'Follow toggle',
  '媒体': 'Media',
  '本站媒体列表，游标分页': 'Media list for this site, cursor-paginated',
  '打开上传会话': 'Open an upload session',
  'multipart 上传字节': 'Upload bytes as multipart',
  '触发安全检查': 'Trigger the security check',
  '只允许 clean 资源': 'Clean assets only',
  '消息与事件': 'Messages and events',
  '我的会话': 'My conversations',
  '读取与发送': 'Read and send',
  '推进已读游标': 'Advance the read cursor',
  '通知与未读数': 'Notifications and the unread count',
  '全部已读': 'Mark all as read',
  '断线补偿（前端轮询降级）': 'Catch-up after a drop (front-end polling fallback)',
  '实时事件通道（本版未启用）': 'Realtime event channel (not enabled in this version)',

  // ---- 端点表表头与状态 ----
  '已接入的端点': 'Endpoints already wired up',
  '全部通过统一客户端调用，自动附加请求 ID 与幂等键。':
    'All of them go through the shared client, which attaches a request ID and an idempotency key automatically.',
  '{count} 条': { one: '1 endpoint', other: '{count} endpoints' },
  '模块': 'Module',
  '方法': 'Method',
  '路径': 'Path',
  '说明': 'Description',
  '状态': 'Status',
  '刷新': 'Refresh',
  '已接入': 'Wired up',
  '未启用': 'Not enabled',

  // ---- 旧缺口文案（2026-11 起页面不再引用；保留历史翻译，不代表当前状态） ----
  '契约缺口与处理方式': 'Contract gaps and how they are handled',
  '这些问题不靠前端伪造接口解决，而是在界面上明确说明。':
    'They are not solved by faking an interface in the front end; the UI states them plainly instead.',
  '站点策略': 'Site policy',
  '站点形态、评论开关、先审后发、主题、页面与权限组没有服务端端点，保存在本地安装配置；':
    'There are no server endpoints for the site shape, the comments switch, review-before-publish, the theme, pages, or permission groups; they live in the local install config;',
  '服务端仍按四级固定角色授权。切换形态不会删除账户与内容。':
    'the server still authorizes by the four fixed roles. Switching the shape deletes neither accounts nor content.',
  '作者与用户资料': 'Authors and user profiles',
  'Content 不返回 author，也没有用户查询端点。演示数据带扩展字段；真实后端隐藏关注与作者归档。':
    'Content does not return author, and there is no user lookup endpoint. Demo data carries extra fields; against a real backend, following and author archives are hidden.',
  '源文读取': 'Reading the source body',
  '编辑草稿需要 source_body，但接口只返回 rendered_html。真实后端下编辑入口关闭，避免空白覆盖。':
    'Editing a draft needs source_body, but the API only returns rendered_html. Against a real backend the edit entry point is disabled so a blank body cannot overwrite the original.',
  '站点创建': 'Creating a site',
  '平台站点列表（平台管理员）': 'Platform site list (platform administrator)',
  '新建站点、默认设计与初始管理员': 'Create a site with its default design and first administrator',
  '站点详情（平台管理员或本站管理员）':
    'Site details (platform administrator or the site’s own administrator)',
  '进入站点：签发短期交接令牌': 'Enter a site: issues a short-lived handoff token',
  '兑换新站点的域名 TXT 挑战': 'Redeem a new site’s domain TXT challenge',
  '在目标站点源兑换交接令牌': 'Redeem the handoff token on the target origin',
  '站点创建已由平台控制台补齐：平台管理员可以列出部署内站点、新建站点（同时初始化默认设计与第一位站点管理员）并进入目标站点的管理后台。单站点安装仍可直接用 seed / 桌面引导启动。':
    'Site creation is now covered by the platform console: a platform administrator can list the deployment’s sites, create one (initialising its default design and first site administrator) and enter the target site’s admin area. A single-site install can still start from seed or the desktop bootstrap.',
  'OpenAPI 没有创建站点端点。安装引导在真实后端上注册管理员、读取默认站点，再 PATCH 设置。':
    'OpenAPI has no endpoint for creating a site. Against a real backend the setup wizard registers an admin, reads the default site, and then PATCHes the settings.',
  '主题、页面、封面与扩展': 'Theme, pages, covers, and extensions',
  'OpenAPI 没有外观、页面、文章封面或插件端点。这些都存在本地安装配置，外观页提供 JSON':
    'OpenAPI has no endpoint for appearance, pages, article covers, or plugins. All of it lives in the local install config; the appearance page offers JSON',
  '导入 / 导出，扩展另有自己的 `.ppext.json` 清单格式；不伪装成会同步到其他设备。':
    'import and export, extensions have their own `.ppext.json` manifest format, and none of it pretends to sync to other devices.',
  '文章封面按内容 id 覆盖，列表与详情页只影响展示，不写入正文。':
    'Article covers are overridden per content id; the list and detail views only change presentation, never the body text.',
  '注册开关': 'Registration switch',
  'Site 没有站点形态或注册开关字段。个人博客的注册关闭由前端实现（隐藏入口、关闭注册页、':
    'Site has no field for the site shape or a registration switch. Closing registration on a personal blog is done by the front end (hiding the entry, closing the sign-up page,',
  '只接受站长邮箱）；真实后端仍需自行禁止 POST /api/v1/register。':
    'accepting only the owner’s email); a real backend still has to block POST /api/v1/register itself.',
  '手机与第三方登录': 'Phone and third-party sign-in',
  'OpenAPI 只有邮箱注册与密码登录，没有短信或 OAuth 端点。安装引导与站点设置可以记录开关、Client ID、':
    'OpenAPI only has email registration and password sign-in, with no SMS or OAuth endpoint. The setup wizard and site settings can record the switch, the Client ID,',
  '回调地址与 scope，并生成服务端 .env；演示模式会模拟入口，真实登录仍需服务端实现对应端点。':
    'the callback URL, and the scope, and generate the server .env; demo mode simulates the entry points, while real sign-in still needs the server to implement those endpoints.',
  '访问端口': 'Access port',
  'OpenAPI 没有服务端口字段。默认 80，由': 'OpenAPI has no service port field. It defaults to 80, served by the static server from',
  '的静态服务提供，可在站点设置修改；运行时接口':
    'and can be changed in site settings; the runtime endpoint',
  '只监听本机，不属于 API 契约。': 'listens on this machine only and is not part of the API contract.',
  '举报与审核列表': 'Reports and the moderation queue',
  '设计文档提到举报，但 v0.1.0 没有 /moderation 或 /reports 路由。前端不提供无法兑现的入口。':
    'The design document mentions reports, but v0.1.0 has no /moderation or /reports route. The front end does not offer an entry point it cannot deliver.',

  // ---- 按当前代码重写的端点分组与状态 ----
  '认证与账号': 'Authentication and account',
  '修改昵称、简介与头像': 'Change the display name, bio, and avatar',
  '发送邮箱验证邮件': 'Send an email verification message',
  '兑换邮箱验证令牌': 'Redeem the email verification token',
  '修改密码并下线其他设备': 'Change the password and sign out other devices',
  '发送重置邮件（无论邮箱是否存在都 202）':
    'Send a reset email (202 whether or not the address exists)',
  '兑换重置令牌并吊销会话': 'Redeem the reset token and revoke sessions',
  '站点与成员': 'Site and members',
  '修改名称、域名与站点策略': 'Change the name, domain, and site policies',
  '读取 / 保存主题、页面、封面、扩展与 SEO':
    'Read / save the theme, pages, covers, extensions, and SEO',
  '启用 / 停用成员': 'Enable / disable a member',
  '成员媒体额度': 'Member media quota',
  '移除成员': 'Remove a member',
  '读取 / 保存主域名': 'Read / save the primary domain',
  '验证主域名归属': 'Verify ownership of the primary domain',
  '公开成员资料': 'Public member profile',
  '服务端审计日志': 'Server-side audit log',
  '平台站点': 'Platform sites',
  '编辑草稿或已发布内容': 'Edit a draft or published content',
  '版本历史（最多 20 版）': 'Revision history (up to 20 versions)',
  '读取历史版本': 'Read a historical revision',
  '回滚到历史版本': 'Roll back to a historical revision',
  '社区与审核': 'Community and moderation',
  '通过 / 拒绝待审评论': 'Approve / reject a pending comment',
  '点赞 / 收藏 / 关注状态': 'Reaction / bookmark / follow state',
  '我的收藏 / 点赞 / 阅读历史': 'My bookmarks / likes / reading history',
  '关注与粉丝': 'Following and followers',
  '提交举报（同一目标去重）': 'File a report (deduplicated per target)',
  '举报队列（审核员）': 'Report queue (reviewers)',
  '认领举报': 'Claim a report',
  '结案：忽略 / 下架 / 封禁': 'Resolve: ignore / take down / ban',
  '消息与实时': 'Messages and realtime',
  '我的会话 / 创建会话': 'My conversations / create a conversation',
  '单条 / 全部已读': 'Mark one / all as read',
  '断线补偿（按游标补发）': 'Catch-up after a drop (replay by cursor)',
  '申请一次性 WebSocket 票据': 'Request a one-time WebSocket ticket',
  '实时事件通道（一次性票据）': 'Realtime event channel (one-time ticket)',
  '分类与统计': 'Taxonomy and analytics',
  '分类与标签列表 / 新建': 'Category and tag list / create one',
  '修改 / 删除分类或标签': 'Update / delete a category or tag',
  '访问统计': 'Visit analytics',
  '记录访问': 'Record a visit',
  '站点文件与文档': 'Site files and documentation',
  '按 Host 输出 sitemap（站点根路径）': 'Serve the sitemap per Host (site root)',
  '按 Host 输出 robots.txt（站点根路径）': 'Serve robots.txt per Host (site root)',
  '自托管接口参考页（不在契约路径表）':
    'Self-hosted API reference page (not in the contract path table)',
  '内嵌 OpenAPI 文档': 'Embedded OpenAPI document',
  '安装状态与注册开关': 'Install status and the registration switch',
  '前端严格按 OpenAPI 0.1.0 实现；本页按当前代码分档记录已接入端点、仅演示能力与已知限制。':
    'The front end follows OpenAPI 0.1.0. This page records, by current-code status, the endpoints already wired up, demo-only capabilities, and known limits.',
  '契约规模由仓库中的 openapi.yaml 统计；站点文件与文档页不进入契约路径表。':
    'The contract size is counted from the repository’s openapi.yaml; site files and the docs page are not part of the contract path table.',
  '契约规模': 'Contract size',
  '83 条路径 / 100 个操作（OpenAPI 0.1.0）':
    '83 paths / 100 operations (OpenAPI 0.1.0)',
  '站点文件': 'Site files',
  '文档页': 'Docs page',
  '实时事件优先走 WebSocket：登录后申请一次性票据连接 /ws，断线用 GET /events 按游标补偿；连接不可用时自动降级为每 45 秒轮询。':
    'Realtime prefers WebSocket: after sign-in the client requests a one-time ticket and connects to /ws; after a drop it catches up with GET /events by cursor. When the connection is unavailable it falls back to a 45-second poll.',
  '按模块列出的前端调用面；完整契约以 openapi.json 为准。':
    'The endpoints the front end calls, grouped by module; the complete contract is openapi.json.',
  '能力状态与已知限制': 'Capability status and known limits',
  '按当前代码分档：已实现、仅演示 / 本地策略、已知限制；不把演示效果写成服务端能力。':
    'Status by current code: implemented, demo-only / local policy, and known limits. Demo behaviour is never described as a server capability.',
  '已实现（曾经列为缺口）': 'Implemented (previously listed as gaps)',
  '注册与评论策略': 'Registration and comment policy',
  'Site 已有 registration_open、comments_enabled、comments_require_review；通过 PATCH /sites/{siteID}/settings 保存，注册关闭时 POST /auth/register/email 返回 403。':
    'Site now carries registration_open, comments_enabled, and comments_require_review, saved through PATCH /sites/{siteID}/settings; when registration is closed, POST /auth/register/email returns 403.',
  '用户资料与作者归档': 'User profiles and author archives',
  'GET /users/{userID} 提供公开资料，PATCH /me/profile 与 POST /auth/password/change 已接入成员主页；作者归档用 ?author_id= 过滤。':
    'GET /users/{userID} serves the public profile; PATCH /me/profile and POST /auth/password/change are wired into the member page; author archives filter with ?author_id=.',
  '主题、页面与扩展': 'Themes, pages, and extensions',
  'GET/PUT /sites/{siteID}/customization 保存整份站点设计（revision 乐观并发），本地配置只作首屏缓存。':
    'GET/PUT /sites/{siteID}/customization stores the whole site design (optimistic concurrency via revision); local config is only a first-paint cache.',
  '举报与审核': 'Reports and moderation',
  'GET/POST /reports、assign、resolve 已交付；/admin/reports 可认领、忽略、下架与封禁。':
    'GET/POST /reports, assign, and resolve are implemented; /admin/reports can claim, ignore, take down, and ban.',
  '操作审计': 'Activity audit',
  'GET /sites/{siteID}/audit-logs 支持筛选与分页；/admin/activity 已改读服务端 audit_logs。':
    'GET /sites/{siteID}/audit-logs supports filters and paging; /admin/activity now reads the server-side audit_logs.',
  '邮箱验证与改密': 'Email verification and password change',
  'POST /me/email/verification 发送验证邮件，POST /auth/email/verify 兑换令牌；改密会下线其他设备。':
    'POST /me/email/verification sends the verification mail and POST /auth/email/verify redeems the token; changing the password signs out other devices.',
  '实时事件': 'Realtime events',
  'POST /auth/ws-ticket + GET /ws 建立长连接，GET /events 断线补偿；不可用时降级为 45 秒轮询。':
    'POST /auth/ws-ticket plus GET /ws opens the long-lived connection, and GET /events catches up after a drop; when unavailable it falls back to a 45-second poll.',
  'sitemap / robots': 'sitemap / robots',
  'Go API 在站点根路径按 Host 输出 /sitemap.xml 与 /robots.txt；后台仍可下载静态副本。':
    'The Go API serves /sitemap.xml and /robots.txt at the site root per Host; the admin can still download static copies.',
  '文档页与平台站点': 'Docs page and platform sites',
  'GET /api/v1/docs 与 /api/v1/openapi.json 已内嵌；/platform/sites 支持列站、建站、进入与域名验证。':
    'GET /api/v1/docs and /api/v1/openapi.json are embedded; /platform/sites lists, creates, enters, and verifies domains.',
  '仅演示模式或前端本地策略': 'Demo-only or front-end local policy',
  '站点形态与权限组': 'Site shape and permission groups',
  'site_kind 与 permissions.ts 仍是前端策略层；服务端按 platform_admin / site_admin / editor / member 四级固定角色授权。':
    'site_kind and permissions.ts remain front-end policy; the server authorizes by the four fixed roles platform_admin / site_admin / editor / member.',
  '只记录开关与非机密参数并生成 .env；没有短信或 OAuth 端点，演示模式模拟入口，真实登录需服务端实现。':
    'Only switches and non-secret parameters are recorded and turned into .env snippets; there is no SMS or OAuth endpoint. Demo mode simulates the entry points, while real sign-in needs a server implementation.',
  '访问端口与访问限制': 'Access port and access limits',
  '端口、/__pp/runtime 与 Nginx limit 片段属于本地部署配置；浏览器端限制只约束使用本站脚本的访客。':
    'The port, /__pp/runtime, and the Nginx limit snippets are local deployment configuration; browser-side limits only constrain visitors running this site’s scripts.',
  '已知限制': 'Known limits',
  '作者字段': 'Author fields',
  '内容列表与搜索仍不内嵌 author 对象，需要按 author_id 另取 GET /users/{userID}。':
    'Content lists and search still do not embed an author object; fetch GET /users/{userID} with author_id instead.',
  '邮件通知范围': 'Email notification scope',
  '事务邮件已覆盖找回密码与邮箱验证；评论回复、审核结果等通知邮件模板尚未接入。':
    'Transactional mail covers password reset and email verification; comment-reply and review-result notification templates are not wired up.',
  'SEO 与多副本': 'SEO and multiple replicas',
  'SEO 标签由前端写入 head；WebSocket 票据与 hub 在进程内存，多副本部署需要共享存储。':
    'SEO tags are written into head by the front end; WebSocket tickets and the hub live in process memory, so multiple replicas need shared storage.',
  '尚未实现': 'Not implemented',
  'OAuth 适配器、短信验证码、前端 SDK 生成与搜索分页游标尚未实现。':
    'OAuth adapters, SMS codes, front-end SDK generation, and search pagination cursors are not implemented.',
  '以上状态以当前代码与 OpenAPI 契约核对；完整清单见':
    'These statuses were checked against the current code and the OpenAPI contract; the full list is in',

  // ---- 页脚 ----
  '以上缺口已在': 'These gaps are recorded in',
  '中记录。接口补齐后只需替换': '; once the API catches up you only replace',
  '，页面无需改写。': ', and no page needs rewriting.',
  '返回内容库': 'Back to the content library',
  '站点设置': 'Site settings',
};

export default fragment;
