import { Link } from 'react-router-dom';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { Badge, Callout, CopyButton } from '../../components/ui';
import { Icon } from '../../components/Icon';
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
 */
function endpointGroups(t: (text: string) => string): EndpointGroup[] {
  return [
    {
      group: t('认证'),
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
      ],
    },
    {
      group: t('站点'),
      items: [
        { method: 'GET', path: '/sites/{siteID}', note: t('成员读取站点'), used: true },
        {
          method: 'PATCH',
          path: '/sites/{siteID}/settings',
          note: t('修改名称、域名与两种模式'),
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
          note: t('编辑草稿'),
          used: true,
        },
        {
          method: 'POST',
          path: '/articles/{id}/{action}',
          note: 'submit / publish / reject / archive / restore / security-retry',
          used: true,
        },
        { method: 'GET', path: '/search', note: t('只搜索已发布内容'), used: true },
      ],
    },
    {
      group: t('社区'),
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
          path: '/reactions/{type}/{id}',
          note: t('点赞（幂等切换）'),
          used: true,
        },
        { method: 'POST', path: '/bookmarks/{type}/{id}', note: t('收藏切换'), used: true },
        { method: 'POST', path: '/follows/{userID}', note: t('关注切换'), used: true },
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
      group: t('消息与事件'),
      items: [
        { method: 'GET', path: '/conversations', note: t('我的会话'), used: true },
        {
          method: 'GET/POST',
          path: '/conversations/{id}/messages',
          note: t('读取与发送'),
          used: true,
        },
        { method: 'POST', path: '/conversations/{id}/read', note: t('推进已读游标'), used: true },
        { method: 'GET', path: '/notifications', note: t('通知与未读数'), used: true },
        { method: 'POST', path: '/notifications/read-all', note: t('全部已读'), used: true },
        { method: 'GET', path: '/events', note: t('断线补偿（前端轮询降级）'), used: false },
        { method: 'GET', path: '/ws?ticket', note: t('实时事件通道（本版未启用）'), used: false },
      ],
    },
  ];
}

export function DocsPage() {
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
          <p>{t('前端严格按 OpenAPI 0.1.0 实现；本页记录已接入的端点与仍在契约里的缺口。')}</p>
        </div>
        <div className="admin-page-actions">
          {docs ? (
            <a href={docs} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              Swagger UI <Icon name="external" size={13} />
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
              <p>{t('来自设计文档第 7 章与 OpenAPI 描述。')}</p>
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
              {t('实时事件使用文档 7.7 允许的轮询降级：每 45 秒刷新未读通知，窗口重新获得焦点时也会刷新。')}{' '}
              {t('WebSocket 票据端点已存在于契约，但本版没有启用长连接；消息页在打开会话时读取一次并按需刷新。')}
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
            <p>{t('全部通过统一客户端调用，自动附加请求 ID 与幂等键。')}</p>
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
            <h3>{t('契约缺口与处理方式')}</h3>
            <p>{t('这些问题不靠前端伪造接口解决，而是在界面上明确说明。')}</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="mini-list">
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('站点策略')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('站点形态、评论开关、先审后发、主题、页面与权限组没有服务端端点，保存在本地安装配置；')}{' '}
                {t('服务端仍按四级固定角色授权。切换形态不会删除账户与内容。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('作者与用户资料')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('Content 不返回 author，也没有用户查询端点。演示数据带扩展字段；真实后端隐藏关注与作者归档。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('源文读取')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('编辑草稿需要 source_body，但接口只返回 rendered_html。真实后端下编辑入口关闭，避免空白覆盖。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('站点创建')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('OpenAPI 没有创建站点端点。安装引导在真实后端上注册管理员、读取默认站点，再 PATCH 设置。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('主题、页面、封面与扩展')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('OpenAPI 没有外观、页面、文章封面或插件端点。这些都存在本地安装配置，外观页提供 JSON')}{' '}
                {t('导入 / 导出，扩展另有自己的 `.ppext.json` 清单格式；不伪装成会同步到其他设备。')}{' '}
                {t('文章封面按内容 id 覆盖，列表与详情页只影响展示，不写入正文。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('操作审计')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('没有审计端点。媒体列表由 GET /media 提供，操作记录仍只按浏览器本地记录呈现，并注明不是合规审计。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('注册开关')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('Site 没有站点形态或注册开关字段。个人博客的注册关闭由前端实现（隐藏入口、关闭注册页、')}{' '}
                {t('只接受站长邮箱）；真实后端仍需自行禁止 POST /api/v1/register。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('手机与第三方登录')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('OpenAPI 只有邮箱注册与密码登录，没有短信或 OAuth 端点。安装引导与站点设置可以记录开关、Client ID、')}{' '}
                {t('回调地址与 scope，并生成服务端 .env；演示模式会模拟入口，真实登录仍需服务端实现对应端点。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('访问端口')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('OpenAPI 没有服务端口字段。默认 80，由')}{' '}
                <code className="mono">npm start</code>{' '}
                {t('的静态服务提供，可在站点设置修改；运行时接口')}{' '}
                <code className="mono">/__pp/runtime</code>{' '}
                {t('只监听本机，不属于 API 契约。')}
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                {t('举报与审核列表')}
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                {t('设计文档提到举报，但 v0.1.0 没有 /moderation 或 /reports 路由。前端不提供无法兑现的入口。')}
              </span>
            </div>
          </div>
          <p className="tiny faint mt-16">
            {t('以上缺口已在')} <code className="mono">apps/web/README.md</code>{' '}
            {t('中记录。接口补齐后只需替换')}
            <code className="mono"> lib/api.ts </code>
            {t('，页面无需改写。')}
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
