import { Link } from 'react-router-dom';
import { useBackend } from '../../lib/backend';
import { APP_VERSION_LABEL } from '../../lib/appVersion';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { Badge, Callout, CopyButton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useT } from '../../lib/i18n';

interface Endpoint {
  method: string;
  path: string;
  note: string;
  used: boolean;
}

interface EndpointGroup {
  group: string;
  items: Endpoint[];
}

/**
 * 端点总表。
 *
 * 分组名与说明是界面文案，所以取当前语言；方法、路径与动作名都是契约里的
 * 标识，保持原样，不随语言变化。
 *
 * 这份表按「前端实际调用」整理，不是 openapi.yaml 的镜像：契约规模在页头单独
 * 标注（当前 83 条路径 / 100 个操作），站点根路径的 sitemap / robots 与内置
 * `/api/v1/docs` 不在契约路径表里。
 */
function endpointGroups(t: (text: string) => string): EndpointGroup[] {
  return [
    {
      group: t('认证与账号'),
      items: [
        { method: 'POST', path: '/auth/register/email', note: t('注册并建立会话'), used: true },
        { method: 'POST', path: '/auth/login/password', note: t('邮箱密码登录'), used: true },
        {
          method: 'POST',
          path: '/auth/token/refresh',
          note: t('轮换会话，需要 X-CSRF-Token'),
          used: true,
        },
        { method: 'POST', path: '/auth/logout', note: t('撤销当前会话'), used: true },
        { method: 'GET', path: '/me', note: t('当前用户、角色与站点'), used: true },
        {
          method: 'PATCH',
          path: '/me/profile',
          note: t('修改昵称、简介与头像'),
          used: true,
        },
        {
          method: 'POST',
          path: '/me/email/verification',
          note: t('发送邮箱验证邮件'),
          used: true,
        },
        {
          method: 'POST',
          path: '/auth/email/verify',
          note: t('兑换邮箱验证令牌'),
          used: true,
        },
        {
          method: 'POST',
          path: '/auth/password/change',
          note: t('修改密码并下线其他设备'),
          used: true,
        },
        {
          method: 'POST',
          path: '/auth/password-reset/request',
          note: t('发送重置邮件（无论邮箱是否存在都 202）'),
          used: true,
        },
        {
          method: 'POST',
          path: '/auth/password-reset/confirm',
          note: t('兑换重置令牌并吊销会话'),
          used: true,
        },
      ],
    },
    {
      group: t('站点与成员'),
      items: [
        { method: 'GET', path: '/sites/{siteID}', note: t('成员读取站点'), used: true },
        {
          method: 'PATCH',
          path: '/sites/{siteID}/settings',
          note: t('修改名称、域名与站点策略'),
          used: true,
        },
        {
          method: 'GET/PUT',
          path: '/sites/{siteID}/customization',
          note: t('读取 / 保存主题、页面、封面、扩展与 SEO'),
          used: true,
        },
        {
          method: 'GET',
          path: '/sites/{siteID}/members',
          note: t('成员列表（站点管理员）'),
          used: true,
        },
        {
          method: 'POST',
          path: '/sites/{siteID}/members',
          note: t('创建账户（站点管理员）'),
          used: true,
        },
        {
          method: 'PATCH',
          path: '/sites/{siteID}/members/{userID}/role',
          note: t('调整角色'),
          used: true,
        },
        {
          method: 'PATCH',
          path: '/sites/{siteID}/members/{userID}/status',
          note: t('启用 / 停用成员'),
          used: true,
        },
        {
          method: 'PATCH',
          path: '/sites/{siteID}/members/{userID}/quota',
          note: t('成员媒体额度'),
          used: true,
        },
        {
          method: 'DELETE',
          path: '/sites/{siteID}/members/{userID}',
          note: t('移除成员'),
          used: true,
        },
        {
          method: 'GET/PUT',
          path: '/sites/{siteID}/domain',
          note: t('读取 / 保存主域名'),
          used: true,
        },
        {
          method: 'POST',
          path: '/sites/{siteID}/domain/verify',
          note: t('验证主域名归属'),
          used: true,
        },
        { method: 'GET', path: '/users/{userID}', note: t('公开成员资料'), used: true },
        {
          method: 'GET',
          path: '/sites/{siteID}/audit-logs',
          note: t('服务端审计日志'),
          used: true,
        },
      ],
    },
    {
      group: t('平台站点'),
      items: [
        {
          method: 'GET',
          path: '/platform/sites',
          note: t('平台站点列表（平台管理员）'),
          used: true,
        },
        {
          method: 'POST',
          path: '/platform/sites',
          note: t('新建站点、默认设计与初始管理员'),
          used: true,
        },
        {
          method: 'GET',
          path: '/platform/sites/{siteID}',
          note: t('站点详情（平台管理员或本站管理员）'),
          used: true,
        },
        {
          method: 'POST',
          path: '/platform/sites/{siteID}/enter',
          note: t('进入站点：签发短期交接令牌'),
          used: true,
        },
        {
          method: 'POST',
          path: '/platform/sites/{siteID}/domain/verify',
          note: t('兑换新站点的域名 TXT 挑战'),
          used: true,
        },
        {
          method: 'POST',
          path: '/platform/enter/claim',
          note: t('在目标站点源兑换交接令牌'),
          used: true,
        },
      ],
    },
    {
      group: t('内容'),
      items: [
        { method: 'GET', path: '/articles · /posts', note: t('游标分页列表'), used: true },
        { method: 'GET', path: '/articles/{id} · /posts/{id}', note: t('读取单篇'), used: true },
        {
          method: 'POST',
          path: '/articles · /posts',
          note: t('创建草稿，服务端清洗'),
          used: true,
        },
        {
          method: 'PATCH',
          path: '/articles/{id} · /posts/{id}',
          note: t('编辑草稿或已发布内容'),
          used: true,
        },
        {
          method: 'POST',
          path: '/articles/{id}/{action}',
          note: 'submit / publish / reject / archive / restore / security-retry',
          used: true,
        },
        {
          method: 'GET',
          path: '/articles/{id}/revisions',
          note: t('版本历史（最多 20 版）'),
          used: true,
        },
        {
          method: 'GET',
          path: '/articles/{id}/revisions/{revisionID}',
          note: t('读取历史版本'),
          used: true,
        },
        {
          method: 'POST',
          path: '/articles/{id}/revisions/{revisionID}/restore',
          note: t('回滚到历史版本'),
          used: true,
        },
        { method: 'GET', path: '/search', note: t('只搜索已发布内容'), used: true },
      ],
    },
    {
      group: t('社区与审核'),
      items: [
        {
          method: 'GET',
          path: '/comments',
          note: t('评论列表（公开站点匿名可读，支持筛选与分页）'),
          used: true,
        },
        { method: 'POST', path: '/comments', note: t('评论与回复'), used: true },
        {
          method: 'PATCH',
          path: '/comments/{id}',
          note: t('作者编辑正文 / 审核员切换可见性'),
          used: true,
        },
        { method: 'DELETE', path: '/comments/{id}', note: t('作者或审核员删除'), used: true },
        {
          method: 'POST',
          path: '/comments/{id}/approve · /reject',
          note: t('通过 / 拒绝待审评论'),
          used: true,
        },
        {
          method: 'GET',
          path: '/interactions/state · /states',
          note: t('点赞 / 收藏 / 关注状态'),
          used: true,
        },
        {
          method: 'POST',
          path: '/reactions/{type}/{id}',
          note: t('点赞（幂等切换）'),
          used: true,
        },
        { method: 'POST', path: '/bookmarks/{type}/{id}', note: t('收藏切换'), used: true },
        { method: 'POST', path: '/follows/{userID}', note: t('关注切换'), used: true },
        {
          method: 'GET',
          path: '/me/bookmarks · /me/likes · /me/reading-history',
          note: t('我的收藏 / 点赞 / 阅读历史'),
          used: true,
        },
        {
          method: 'GET',
          path: '/me/following · /me/followers',
          note: t('关注与粉丝'),
          used: true,
        },
        {
          method: 'POST',
          path: '/reports',
          note: t('提交举报（同一目标去重）'),
          used: true,
        },
        { method: 'GET', path: '/reports', note: t('举报队列（审核员）'), used: true },
        {
          method: 'POST',
          path: '/reports/{id}/assign',
          note: t('认领举报'),
          used: true,
        },
        {
          method: 'POST',
          path: '/reports/{id}/resolve',
          note: t('结案：忽略 / 下架 / 封禁'),
          used: true,
        },
      ],
    },
    {
      group: t('媒体'),
      items: [
        { method: 'GET', path: '/media', note: t('本站媒体列表，游标分页'), used: true },
        { method: 'POST', path: '/media/uploads', note: t('打开上传会话'), used: true },
        {
          method: 'POST',
          path: '/media/uploads/{id}/content',
          note: t('multipart 上传字节'),
          used: true,
        },
        {
          method: 'POST',
          path: '/media/uploads/{id}/complete',
          note: t('触发安全检查'),
          used: true,
        },
        { method: 'GET', path: '/media/{assetID}', note: t('只允许 clean 资源'), used: true },
      ],
    },
    {
      group: t('消息与实时'),
      items: [
        {
          method: 'GET/POST',
          path: '/conversations',
          note: t('我的会话 / 创建会话'),
          used: true,
        },
        {
          method: 'GET/POST',
          path: '/conversations/{id}/messages',
          note: t('读取与发送'),
          used: true,
        },
        { method: 'POST', path: '/conversations/{id}/read', note: t('推进已读游标'), used: true },
        { method: 'GET', path: '/notifications', note: t('通知与未读数'), used: true },
        {
          method: 'POST',
          path: '/notifications/{id}/read · /read-all',
          note: t('单条 / 全部已读'),
          used: true,
        },
        {
          method: 'GET',
          path: '/events',
          note: t('断线补偿（按游标补发）'),
          used: true,
        },
        {
          method: 'POST',
          path: '/auth/ws-ticket',
          note: t('申请一次性 WebSocket 票据'),
          used: true,
        },
        { method: 'GET', path: '/ws', note: t('实时事件通道（一次性票据）'), used: true },
      ],
    },
    {
      group: t('分类与统计'),
      items: [
        {
          method: 'GET/POST',
          path: '/sites/{siteID}/taxonomy',
          note: t('分类与标签列表 / 新建'),
          used: true,
        },
        {
          method: 'PATCH/DELETE',
          path: '/sites/{siteID}/taxonomy/{termID}',
          note: t('修改 / 删除分类或标签'),
          used: true,
        },
        {
          method: 'GET',
          path: '/sites/{siteID}/analytics',
          note: t('访问统计'),
          used: true,
        },
        { method: 'POST', path: '/analytics/visits', note: t('记录访问'), used: true },
      ],
    },
    {
      group: t('站点文件与文档'),
      items: [
        {
          method: 'GET',
          path: '/sitemap.xml',
          note: t('按 Host 输出 sitemap（站点根路径）'),
          used: true,
        },
        {
          method: 'GET',
          path: '/robots.txt',
          note: t('按 Host 输出 robots.txt（站点根路径）'),
          used: true,
        },
        {
          method: 'GET',
          path: '/api/v1/docs',
          note: t('自托管接口参考页（不在契约路径表）'),
          used: true,
        },
        {
          method: 'GET',
          path: '/api/v1/openapi.json',
          note: t('内嵌 OpenAPI 文档'),
          used: true,
        },
        {
          method: 'GET',
          path: '/api/v1/setup/status',
          note: t('安装状态与注册开关'),
          used: true,
        },
      ],
    },
  ];
}

export function DocsPage() {
  const t = useT();
  // 接口契约是站长的开发资料：列出全部端点、鉴权方式与错误码结构。
  // 普通成员与只做审核的账户都不该看到这份后台地图。
  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <DocsWorkspace />
    </RoleGate>
  );
}

function DocsWorkspace() {
  const t = useT();
  const backend = useBackend();
  const { config } = useAuth();
  useTitle(t('调用接口'));

  const base = config.mode === 'demo' ? t('演示模式 · 无远程 API') : `${backend.origin || window.location.origin}/api/v1`;
  const docs = config.mode === 'demo' ? '' : `${backend.origin || window.location.origin}/api/v1/docs`;
  const openapi = config.mode === 'demo' ? '' : `${backend.origin || window.location.origin}/api/v1/openapi.json`;

  const groups = endpointGroups(t);
  const endpointCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  /**
   * Problem 示例里的 `message` 是服务端本地化文案，跟着界面语言走；
   * 其余字段是契约标识，保持原样。
   */
  const problemMessage = t('当前用户没有执行此操作的权限');
  const problemFull = `{
  "type": "https://docs.practacu.press/errors/permission_denied",
  "title": "Permission denied",
  "status": 403,
  "code": "permission_denied",
  "message": "${problemMessage}",
  "details": {},
  "request_id": "req_01"
}`;
  const problemShort = `{
  "type": ".../permission_denied",
  "status": 403,
  "code": "permission_denied",
  "message": "${problemMessage}",
  "request_id": "req_01"
}`;

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('调用接口')}</h1>
          <p>
            {t(
              '前端严格按当前 OpenAPI 契约实现；本页按当前代码分档记录已接入端点、仅演示能力与已知限制。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          {docs ? (
            <a href={docs} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              {t('API 参考')} <Icon name="external" size={13} />
            </a>
          ) : null}
          {openapi ? (
            <a href={openapi} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              openapi.json <Icon name="external" size={13} />
            </a>
          ) : (
            <span className="chip">{t('演示模式')}</span>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('基础约定')}</h3>
              <p>{t('契约规模由仓库中的 openapi.yaml 统计；站点文件与文档页不进入契约路径表。')}</p>
            </div>
          </div>
          <div className="panel-body" style={{ paddingTop: 6 }}>
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('API 根路径')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  {base}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('鉴权')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  Authorization: Bearer &lt;JWT&gt;
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('刷新')}</span>
                <span className="mini-value">HttpOnly Cookie + X-CSRF-Token</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('错误体')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  application/problem+json
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('列表')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  items / next_cursor / has_more
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('时间与枚举')}</span>
                <span className="mini-value">{t('UTC ISO 8601 · 小写蛇形')}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('契约版本')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  {APP_VERSION_LABEL}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('契约规模')}</span>
                <span className="mini-value">{t('83 条路径 / 100 个操作')}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('站点文件')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  /sitemap.xml · /robots.txt
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('文档页')}</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  /api/v1/docs · /api/v1/openapi.json
                </span>
              </div>
            </div>

            <div className="code-block-head mt-20">
              <span>{t('Problem 示例')}</span>
              <CopyButton value={problemFull} />
            </div>
            <pre className="code-block">{problemShort}</pre>
            <p className="field-hint mt-8">
              {t('前端分支判断只依赖')} <code className="mono">code</code>
              {t('；')}
              <code className="mono">message</code> {t('是本地化文案，可能变化。')}
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('会话与实时')}</h3>
              <p>{t('安全边界与降级路径。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <p className="small muted" style={{ lineHeight: 1.85 }}>
              {t('Access Token 只保存在内存，刷新页面后通过 HttpOnly Refresh Cookie 重新获取；刷新时读取可读的')}
              <code className="mono"> pp_csrf </code>{' '}
              {t('Cookie 作为双提交令牌。刷新失败会清空本地会话并回到登录页。')}
            </p>
            <p className="small muted mt-12" style={{ lineHeight: 1.85 }}>
              {t(
                '实时事件优先走 WebSocket：登录后申请一次性票据连接 /ws，断线用 GET /events 按游标补偿；连接不可用时自动降级为每 45 秒轮询。',
              )}
            </p>
            <Callout tone="warn" icon="shield" title={t('前端不是安全边界')}>
              {t('所有权限判断都在服务端。界面隐藏按钮、禁用表单只是体验优化，不能替代授权。')}
            </Callout>
          </div>
        </section>
      </div>

      <section className="panel mt-24">
        <div className="panel-head">
          <div>
            <h3>{t('已接入的端点')}</h3>
            <p>{t('按模块列出的前端调用面；完整契约以 openapi.json 为准。')}</p>
          </div>
          <Badge tone="ok">{t('{count} 条', { count: endpointCount })}</Badge>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('模块')}</th>
                <th>{t('方法')}</th>
                <th>{t('路径')}</th>
                <th>{t('说明')}</th>
                <th>{t('状态')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((group) =>
                group.items.map((item, index) => (
                  <tr key={`${group.group}-${item.path}-${index}`}>
                    <td className="cell-title">{index === 0 ? group.group : ''}</td>
                    <td>
                      <span className="mono tiny">{item.method}</span>
                    </td>
                    <td className="mono tiny">{item.path}</td>
                    <td className="tiny muted">{item.note}</td>
                    <td>
                      {item.used ? (
                        <Badge tone="ok">{t('已接入')}</Badge>
                      ) : (
                        <Badge tone="muted">{t('未启用')}</Badge>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel mt-24">
        <div className="panel-head">
          <div>
            <h3>{t('能力状态与已知限制')}</h3>
            <p>
              {t(
                '按当前代码分档：已实现、仅演示 / 本地策略、已知限制；不把演示效果写成服务端能力。',
              )}
            </p>
          </div>
        </div>
        <div className="panel-body">
          <p className="small muted mt-12" style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {t('已实现（曾经列为缺口）')}
          </p>
          <div className="mini-list">
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('注册与评论策略')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'Site 已有 registration_open、comments_enabled、comments_require_review；通过 PATCH /sites/{siteID}/settings 保存，注册关闭时 POST /auth/register/email 返回 403。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('用户资料与作者归档')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'GET /users/{userID} 提供公开资料，PATCH /me/profile 与 POST /auth/password/change 已接入成员主页；作者归档用 ?author_id= 过滤。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('主题、页面与扩展')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'GET/PUT /sites/{siteID}/customization 保存整份站点设计（revision 乐观并发），本地配置只作首屏缓存。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('举报与审核')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'GET/POST /reports、assign、resolve 已交付；/admin/reports 可认领、忽略、下架与封禁。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('操作审计')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'GET /sites/{siteID}/audit-logs 支持筛选与分页；/admin/activity 已改读服务端 audit_logs。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('邮箱验证与改密')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'POST /me/email/verification 发送验证邮件，POST /auth/email/verify 兑换令牌；改密会下线其他设备。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('实时事件')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'POST /auth/ws-ticket + GET /ws 建立长连接，GET /events 断线补偿；不可用时降级为 45 秒轮询。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('sitemap / robots')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'Go API 在站点根路径按 Host 输出 /sitemap.xml 与 /robots.txt；后台仍可下载静态副本。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('文档页与平台站点')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'GET /api/v1/docs 与 /api/v1/openapi.json 已内嵌；/platform/sites 支持列站、建站、进入与域名验证。',
                )}
              </span>
            </div>
          </div>

          <p className="small muted mt-20" style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {t('仅演示模式或前端本地策略')}
          </p>
          <div className="mini-list">
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('站点形态与权限组')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'site_kind 与 permissions.ts 仍是前端策略层；服务端按 platform_admin / site_admin / editor / member 四级固定角色授权。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('手机与第三方登录')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  '只记录开关与非机密参数并生成 .env；没有短信或 OAuth 端点，演示模式模拟入口，真实登录需服务端实现。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('访问端口与访问限制')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  '端口、/__pp/runtime 与 Nginx limit 片段属于本地部署配置；浏览器端限制只约束使用本站脚本的访客。',
                )}
              </span>
            </div>
          </div>

          <p className="small muted mt-20" style={{ fontWeight: 600, color: 'var(--ink)' }}>
            {t('已知限制')}
          </p>
          <div className="mini-list">
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('作者字段')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  '内容列表与搜索仍不内嵌 author 对象，需要按 author_id 另取 GET /users/{userID}。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('邮件通知范围')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  '事务邮件已覆盖找回密码与邮箱验证；评论回复、审核结果等通知邮件模板尚未接入。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('SEO 与多副本')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'SEO 标签由前端写入 head；WebSocket 票据与 hub 在进程内存，多副本部署需要共享存储。',
                )}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('尚未实现')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t(
                  'OAuth 适配器、短信验证码、前端 SDK 生成与搜索分页游标尚未实现。',
                )}
              </span>
            </div>
          </div>

          <p className="tiny faint mt-16">
            {t('以上状态以当前代码与 OpenAPI 契约核对；完整清单见')}{' '}
            <code className="mono">/api/v1/openapi.json</code>。
          </p>
          <div className="row gap-8 mt-16">
            <Link to="/admin/content" className="btn btn-secondary btn-sm">
              {t('返回内容库')}
            </Link>
            <Link to="/admin/settings" className="btn btn-ghost btn-sm">
              {t('站点设置')}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
