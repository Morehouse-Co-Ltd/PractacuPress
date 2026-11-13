import type { Dictionary } from '../../plural';

/**
 * 来源：后台设置页里「站点级配置写服务端」之后新增的提示。
 *
 * 页面片段按源文件拆分，这里集中放这一批改动新增的键，避免与各页面原有片段
 * （`pages_admin_Access.ts` 等）逐个合并时产生冲突。
 */
const fragment: Dictionary = {
  // pages/admin/Access.tsx
  '已写入站点服务端配置：访客刷新页面后按这套规则计数。':
    'Saved to the site server: after a reload, visitors are counted against these rules.',

  // pages/admin/Domains.tsx
  '配置没有保存到服务端，请稍后重试。':
    'The configuration was not saved to the server; try again shortly.',

  // pages/admin/Loading.tsx
  '已写入站点服务端配置：访客等待内容时会看到原位骨架。':
    'Saved to the site server: visitors see in-place skeletons while content loads.',
  '已写入站点服务端配置：访客刷新或切换页面时会看到这段动画。':
    'Saved to the site server: visitors see this animation when they reload or switch pages.',

  // pages/admin/LoginSettings.tsx
  '点击上方五种登录方式切换配置；每种方式只显示自己的参数。开关自动保存到站点服务端，登录页对所有访客显示同一组方式。':
    'Use the five login methods above to switch configuration; each shows only its own parameters. The switches save to the site server automatically, and every visitor sees the same set on the login page.',

  // pages/admin/Performance.tsx
  '仍能及时响应。浏览器侧设置保存到站点服务端，所有访客刷新后按同一套参数运行；服务器超时、连接池与网关缓存会生成部署片段。':
    'Still responds in time under load. Browser-side settings are saved to the site server, so every visitor runs the same parameters after a reload; server timeouts, the connection pool and gateway caching are rendered into deployment snippets.',
  '已写入站点服务端配置：首屏条数、缓存与懒加载对访客生效；服务器超时、数据库连接池与网关缓存需要按片段部署后重启。':
    'Saved to the site server: feed size, caching and lazy loading apply to visitors; server timeouts, the database pool and gateway caching still need the snippets deployed and a restart.',

  // pages/admin/Settings.tsx
  '后台入口没有保存到服务端，仍在使用原来的入口。':
    'The admin entry was not saved to the server; the previous entry is still in use.',
  '自定义后台登录入口路径，例如 /manage。保存后地址栏会立刻改到这个入口，所有访客与设备都从它进后台；原来的 /admin 不再能进入后台。':
    'A custom path for the admin entry, for example /manage. After saving, the address bar switches to it at once and every visitor and device enters the admin there; the old /admin no longer opens the admin.',
};

export default fragment;
