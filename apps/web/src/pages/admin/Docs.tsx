import { Link } from 'react-router-dom';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { Badge, Callout, CopyButton } from '../../components/ui';
import { Icon } from '../../components/Icon';

const ENDPOINTS: { group: string; items: { method: string; path: string; note: string; used: boolean }[] }[] = [
  {
    group: '认证',
    items: [
      { method: 'POST', path: '/auth/register/email', note: '注册并建立会话', used: true },
      { method: 'POST', path: '/auth/login/password', note: '邮箱密码登录', used: true },
      { method: 'POST', path: '/auth/token/refresh', note: '轮换会话，需要 X-CSRF-Token', used: true },
      { method: 'POST', path: '/auth/logout', note: '撤销当前会话', used: true },
      { method: 'GET', path: '/me', note: '当前用户、角色与站点', used: true },
    ],
  },
  {
    group: '站点',
    items: [
      { method: 'GET', path: '/sites/{siteID}', note: '成员读取站点', used: true },
      { method: 'PATCH', path: '/sites/{siteID}/settings', note: '修改名称、域名与两种模式', used: true },
      { method: 'GET', path: '/sites/{siteID}/members', note: '成员列表（站点管理员）', used: true },
      { method: 'POST', path: '/sites/{siteID}/members', note: '创建账户（站点管理员）', used: true },
      { method: 'PATCH', path: '/sites/{siteID}/members/{userID}/role', note: '调整角色', used: true },
    ],
  },
  {
    group: '内容',
    items: [
      { method: 'GET', path: '/articles · /posts', note: '游标分页列表', used: true },
      { method: 'GET', path: '/articles/{id} · /posts/{id}', note: '读取单篇', used: true },
      { method: 'POST', path: '/articles · /posts', note: '创建草稿，服务端清洗', used: true },
      { method: 'PATCH', path: '/articles/{id} · /posts/{id}', note: '编辑草稿', used: true },
      { method: 'POST', path: '/articles/{id}/{action}', note: 'submit / publish / reject / archive / restore / security-retry', used: true },
      { method: 'GET', path: '/search', note: '只搜索已发布内容', used: true },
    ],
  },
  {
    group: '社区',
    items: [
      { method: 'GET', path: '/comments', note: '评论列表（公开站点匿名可读，支持筛选与分页）', used: true },
      { method: 'POST', path: '/comments', note: '评论与回复', used: true },
      { method: 'PATCH', path: '/comments/{id}', note: '作者编辑正文 / 审核员切换可见性', used: true },
      { method: 'DELETE', path: '/comments/{id}', note: '作者或审核员删除', used: true },
      { method: 'POST', path: '/reactions/{type}/{id}', note: '点赞（幂等切换）', used: true },
      { method: 'POST', path: '/bookmarks/{type}/{id}', note: '收藏切换', used: true },
      { method: 'POST', path: '/follows/{userID}', note: '关注切换', used: true },
    ],
  },
  {
    group: '媒体',
    items: [
      { method: 'POST', path: '/media/uploads', note: '打开上传会话', used: true },
      { method: 'POST', path: '/media/uploads/{id}/content', note: 'multipart 上传字节', used: true },
      { method: 'POST', path: '/media/uploads/{id}/complete', note: '触发安全检查', used: true },
      { method: 'GET', path: '/media/{assetID}', note: '只允许 clean 资源', used: true },
    ],
  },
  {
    group: '消息与事件',
    items: [
      { method: 'GET', path: '/conversations', note: '我的会话', used: true },
      { method: 'GET/POST', path: '/conversations/{id}/messages', note: '读取与发送', used: true },
      { method: 'POST', path: '/conversations/{id}/read', note: '推进已读游标', used: true },
      { method: 'GET', path: '/notifications', note: '通知与未读数', used: true },
      { method: 'POST', path: '/notifications/read-all', note: '全部已读', used: true },
      { method: 'GET', path: '/events', note: '断线补偿（前端轮询降级）', used: false },
      { method: 'GET', path: '/ws?ticket', note: '实时事件通道（本版未启用）', used: false },
    ],
  },
];

export function DocsPage() {
  const backend = useBackend();
  const { config } = useAuth();
  useTitle('调用接口');

  const base = config.mode === 'demo' ? '演示模式 · 无远程 API' : `${backend.origin || window.location.origin}/api/v1`;
  const docs = config.mode === 'demo' ? '' : `${backend.origin || window.location.origin}/api/v1/docs`;
  const openapi = config.mode === 'demo' ? '' : `${backend.origin || window.location.origin}/api/v1/openapi.json`;

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>调用接口</h1>
          <p>前端严格按 OpenAPI 0.1.0 实现；本页记录已接入的端点与仍在契约里的缺口。</p>
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
            <span className="chip">演示模式</span>
          )}
        </div>
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>基础约定</h3>
              <p>来自设计文档第 7 章与 OpenAPI 描述。</p>
            </div>
          </div>
          <div className="panel-body" style={{ paddingTop: 6 }}>
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">API 根路径</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  {base}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">鉴权</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  Authorization: Bearer &lt;JWT&gt;
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">刷新</span>
                <span className="mini-value">HttpOnly Cookie + X-CSRF-Token</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">错误体</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  application/problem+json
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">列表</span>
                <span className="mini-value mono" style={{ fontSize: 11 }}>
                  items / next_cursor / has_more
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">时间与枚举</span>
                <span className="mini-value">UTC ISO 8601 · 小写蛇形</span>
              </div>
            </div>

            <div className="code-block-head mt-20">
              <span>Problem 示例</span>
              <CopyButton
                value={`{\n  "type": "https://docs.practacu.press/errors/permission_denied",\n  "title": "Permission denied",\n  "status": 403,\n  "code": "permission_denied",\n  "message": "当前用户没有执行此操作的权限",\n  "details": {},\n  "request_id": "req_01"\n}`}
              />
            </div>
            <pre className="code-block">{`{
  "type": ".../permission_denied",
  "status": 403,
  "code": "permission_denied",
  "message": "当前用户没有执行此操作的权限",
  "request_id": "req_01"
}`}</pre>
            <p className="field-hint mt-8">
              前端分支判断只依赖 <code className="mono">code</code>；<code className="mono">message</code> 是本地化文案，可能变化。
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>会话与实时</h3>
              <p>安全边界与降级路径。</p>
            </div>
          </div>
          <div className="panel-body">
            <p className="small muted" style={{ lineHeight: 1.85 }}>
              Access Token 只保存在内存，刷新页面后通过 HttpOnly Refresh Cookie 重新获取；刷新时读取可读的
              <code className="mono"> pp_csrf </code> Cookie 作为双提交令牌。刷新失败会清空本地会话并回到登录页。
            </p>
            <p className="small muted mt-12" style={{ lineHeight: 1.85 }}>
              实时事件使用文档 7.7 允许的轮询降级：每 45 秒刷新未读通知，窗口重新获得焦点时也会刷新。
              WebSocket 票据端点已存在于契约，但本版没有启用长连接；消息页在打开会话时读取一次并按需刷新。
            </p>
            <Callout tone="warn" icon="shield" title="前端不是安全边界">
              所有权限判断都在服务端。界面隐藏按钮、禁用表单只是体验优化，不能替代授权。
            </Callout>
          </div>
        </section>
      </div>

      <section className="panel mt-24">
        <div className="panel-head">
          <div>
            <h3>已接入的端点</h3>
            <p>全部通过统一客户端调用，自动附加请求 ID 与幂等键。</p>
          </div>
          <Badge tone="ok">{ENDPOINTS.reduce((sum, group) => sum + group.items.length, 0)} 条</Badge>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>模块</th>
                <th>方法</th>
                <th>路径</th>
                <th>说明</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.flatMap((group) =>
                group.items.map((item, index) => (
                  <tr key={`${group.group}-${item.path}-${index}`}>
                    <td className="cell-title">{index === 0 ? group.group : ''}</td>
                    <td>
                      <span className="mono tiny">{item.method}</span>
                    </td>
                    <td className="mono tiny">{item.path}</td>
                    <td className="tiny muted">{item.note}</td>
                    <td>
                      {item.used ? <Badge tone="ok">已接入</Badge> : <Badge tone="muted">未启用</Badge>}
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
            <h3>契约缺口与处理方式</h3>
            <p>这些问题不靠前端伪造接口解决，而是在界面上明确说明。</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="mini-list">
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                站点策略
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                站点形态、评论开关、先审后发、主题、页面与权限组没有服务端端点，保存在本地安装配置；
                服务端仍按四级固定角色授权。切换形态不会删除账户与内容。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                作者与用户资料
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                Content 不返回 author，也没有用户查询端点。演示数据带扩展字段；真实后端隐藏关注与作者归档。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                源文读取
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                编辑草稿需要 source_body，但接口只返回 rendered_html。真实后端下编辑入口关闭，避免空白覆盖。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                站点创建
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                OpenAPI 没有创建站点端点。安装引导在真实后端上注册管理员、读取默认站点，再 PATCH 设置。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                主题、页面、封面与扩展
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                OpenAPI 没有外观、页面、文章封面或插件端点。这些都存在本地安装配置，外观页提供 JSON
                导入 / 导出，扩展另有自己的 `.ppext.json` 清单格式；不伪装成会同步到其他设备。
                文章封面按内容 id 覆盖，列表与详情页只影响展示，不写入正文。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                媒体列表与审计
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                没有列表 / 查询端点。媒体页只显示本次会话上传；操作记录按浏览器本地记录呈现，并注明不是合规审计。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                注册开关
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                Site 没有站点形态或注册开关字段。个人博客的注册关闭由前端实现（隐藏入口、关闭注册页、
                只接受站长邮箱）；真实后端仍需自行禁止 POST /api/v1/register。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                手机与第三方登录
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                OpenAPI 只有邮箱注册与密码登录，没有短信或 OAuth 端点。安装引导与站点设置可以记录开关、Client ID、
                回调地址与 scope，并生成服务端 .env；演示模式会模拟入口，真实登录仍需服务端实现对应端点。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                访问端口
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                OpenAPI 没有服务端口字段。默认 80，由 <code className="mono">npm start</code> 的静态服务提供，
                可在站点设置修改；运行时接口 <code className="mono">/__pp/runtime</code> 只监听本机，
                不属于 API 契约。
              </span>
            </div>
            <div className="mini-row" style={{ alignItems: 'flex-start' }}>
              <span className="mini-label" style={{ minWidth: 150 }}>
                举报与审核列表
              </span>
              <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400, color: 'var(--muted)' }}>
                设计文档提到举报，但 v0.1.0 没有 /moderation 或 /reports 路由。前端不提供无法兑现的入口。
              </span>
            </div>
          </div>
          <p className="tiny faint mt-16">
            以上缺口已在 <code className="mono">apps/web/README.md</code> 中记录。接口补齐后只需替换
            <code className="mono"> lib/api.ts </code>，页面无需改写。
          </p>
          <div className="row gap-8 mt-16">
            <Link to="/admin/content" className="btn btn-secondary btn-sm">
              返回内容库
            </Link>
            <Link to="/admin/settings" className="btn btn-ghost btn-sm">
              站点设置
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
