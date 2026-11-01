import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Docs.tsx` */
const fragment: Dictionary = {
  // ---- 页头 ----
  '调用接口': 'API access',
  '前端严格按 OpenAPI 0.1.0 实现；本页记录已接入的端点与仍在契约里的缺口。':
    'The front end follows OpenAPI 0.1.0 strictly; this page lists the endpoints already wired up and the gaps still left in the contract.',
  '演示模式': 'Demo mode',
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
  '已接入': 'Wired up',

  // ---- 契约缺口 ----
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
  'OpenAPI 没有创建站点端点。安装引导在真实后端上注册管理员、读取默认站点，再 PATCH 设置。':
    'OpenAPI has no endpoint for creating a site. Against a real backend the setup wizard registers an admin, reads the default site, and then PATCHes the settings.',
  '主题、页面、封面与扩展': 'Theme, pages, covers, and extensions',
  'OpenAPI 没有外观、页面、文章封面或插件端点。这些都存在本地安装配置，外观页提供 JSON':
    'OpenAPI has no endpoint for appearance, pages, article covers, or plugins. All of it lives in the local install config; the appearance page offers JSON',
  '导入 / 导出，扩展另有自己的 `.ppext.json` 清单格式；不伪装成会同步到其他设备。':
    'import and export, extensions have their own `.ppext.json` manifest format, and none of it pretends to sync to other devices.',
  '文章封面按内容 id 覆盖，列表与详情页只影响展示，不写入正文。':
    'Article covers are overridden per content id; the list and detail views only change presentation, never the body text.',
  '操作审计': 'Activity audit',
  '没有审计端点。媒体列表由 GET /media 提供，操作记录仍只按浏览器本地记录呈现，并注明不是合规审计。':
    'There is no audit endpoint. The media list comes from GET /media, while the activity log is still rendered from the browser-local record and is marked as not a compliance audit.',
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

  // ---- 页脚 ----
  '以上缺口已在': 'These gaps are recorded in',
  '中记录。接口补齐后只需替换': '; once the API catches up you only replace',
  '，页面无需改写。': ', and no page needs rewriting.',
  '返回内容库': 'Back to the content library',
  '站点设置': 'Site settings',
};

export default fragment;
