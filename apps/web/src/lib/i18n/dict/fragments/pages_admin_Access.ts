import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Access.tsx` */
const fragment: Dictionary = {
  '访问与域名': 'Access and domains',
  '访问限制': 'Access limits',
  '站点管理员': 'Site admin',
  '查看前台': 'View site',
  '访问限制已保存': 'Access limits saved',
  '浏览器端规则立即生效。': 'Browser-side rules take effect immediately.',
  '浏览器端保护当前关闭。': 'Browser-side protection is currently off.',
  '已恢复默认限制': 'Default limits restored',
  '浏览器端保护已关闭；已保存的网关数值也回到默认。':
    'Browser-side protection is now off, and the saved gateway values are back to their defaults.',
  '已解除当前标签页的限制': 'Cleared the limit on this tab',
  '这个标签页里的管理后台与前台页面都可以继续访问。':
    'The dashboard and site pages in this tab can be used again.',

  '启用这条规则': 'Enable this rule',
  '只影响浏览器端记录；网关配置会另外按这里的数值生成。':
    'Only affects the browser-side counters; the gateway config is generated separately from these numbers.',
  '允许次数': 'Allowed count',
  '次': 'times',
  '统计窗口': 'Window',
  '在这个时间范围内统计。': 'Counted within this time range.',
  '秒': 'seconds',
  '触发后暂停': 'Pause after triggering',
  '暂停期间访客会看到拦截页与倒计时。':
    'While paused, visitors see a block page with a countdown.',

  '限制页面切换、页面请求与同浏览器并发页面，避免脚本或异常客户端拖垮站点。':
    'Limits page switches, page requests, and concurrent tabs in one browser, so scripts or misbehaving clients cannot drag the site down.',
  '真正的 IP 级 DDoS / CC 防护由网关执行，本页同时生成可直接部署的规则。':
    'Real IP-level DDoS / CC protection runs at the gateway; this page also generates rules you can deploy as-is.',
  '浏览器端只能挡住使用本站脚本的访问者': 'The browser can only stop visitors running this site’s scripts',
  '它适合拦住失控的前端脚本、误触与普通爬虫，但无法阻止直接请求 API 或静态资源的机器人。':
    'It is good for runaway front-end scripts, accidental clicks, and ordinary crawlers, but it cannot stop bots that request the API or static files directly.',
  '要真正按 IP 限制请求和并发，请把下方片段部署到 Nginx 或 Cloudflare 等网关。':
    'To really limit requests and concurrency per IP, deploy the snippet below to a gateway such as Nginx or Cloudflare.',
  '管理后台、安装向导与页面编排预览始终豁免，站长不会被锁在门外。':
    'The dashboard, the setup wizard, and the layout preview are always exempt, so the site owner is never locked out.',

  '浏览器端保护': 'Browser-side protection',
  '总开关。关闭后下面三条规则都不会在本站脚本里执行。':
    'Master switch. When it is off, none of the three rules below run in this site’s scripts.',
  '已启用': 'Enabled',
  '未启用': 'Not enabled',
  '启用浏览器端访问限制': 'Enable browser-side access limits',
  '建议先启用页面切换与并发页面限制；请求限制可根据站点脚本数量调整。':
    'Start with the page-switch and concurrent-tab limits; adjust the request limit to how many scripts the site loads.',
  '拦截提示': 'Block message',
  '访客被拦住时看到的说明；留空使用默认文案。':
    'The note visitors see when they are blocked; leave it empty to use the default text.',

  '页面切换限制': 'Page switch limit',
  '限制一段时间内打开或切换页面的次数，对应 CC 攻击里最便宜的请求。':
    'Limits how often pages can be opened or switched within a window, the cheapest request in a CC attack.',
  '{limit} 次 / {window} 秒': '{limit} times / {window} seconds',
  '请求限制': 'Request limit',
  '限制页面脚本在窗口内发起的后端请求；命中缓存也按一次调用计。':
    'Limits backend requests made by page scripts within the window; a cache hit still counts as one call.',

  '并发页面': 'Concurrent tabs',
  '同一浏览器允许同时打开的站点标签页；网关里对应每 IP 并发连接。':
    'Site tabs one browser may keep open at once; at the gateway this maps to concurrent connections per IP.',
  '启用并发页面限制': 'Enable the concurrent tab limit',
  '只统计前台标签页，后台和编排预览不占名额。':
    'Only site tabs are counted; the dashboard and the layout preview do not use a slot.',
  '同时打开的页面': 'Tabs open at once',
  '超过后最新打开的标签会被拦住，关闭其他标签即恢复。':
    'Past the limit, the newest tab is blocked until you close another one.',
  '个': 'tabs',
  '浏览器只能看到同一个浏览器': 'The browser only sees itself',
  '浏览器拿不到“同一 IP 的其他设备”。下方 Nginx 的 limit_conn 才是按 IP 的并发连接限制。':
    'The browser cannot see other devices behind the same IP. The Nginx limit_conn below is the per-IP concurrent connection limit.',

  '网关配置': 'Gateway configuration',
  '按已保存的规则生成；复制到 Nginx 后才能真正按 IP 限制请求和并发。':
    'Generated from the saved rules; only once it runs in Nginx are requests and concurrency really limited per IP.',
  '不会自动修改服务器': 'Does not touch the server',
  '复制 Nginx': 'Copy Nginx',
  '复制 API .env': 'Copy API .env',
  '展开 API 环境变量': 'Show API environment variables',
  'Nginx 片段里的 Host 已改写为主域名；否则 API 会把别名域名当成未知站点。':
    'The Host in the Nginx snippet is rewritten to the primary domain; otherwise the API treats alias domains as unknown sites.',
  '片段假设 Nginx 直接读取构建好的静态文件，只把':
    'The snippet assumes Nginx serves the built static files directly and only proxies',
  '代理到 Go 服务。': 'to the Go service.',
  '请求规则只作用在': 'Request rules apply only to',
  '，页面规则作用在 HTML 文档；': ', while page rules apply to HTML documents;',
  '并发页面按每页约 4 条连接换算，避免正常的单页访问被 limit_conn 误伤。':
    'Each concurrent tab is treated as about 4 connections, so a normal single-page visit is not caught by limit_conn.',
  '浏览器端总开关不影响这里的网关规则；不需要某条规则时，把上方对应开关关掉再复制。':
    'The browser-side master switch does not affect these gateway rules; to drop a rule, turn off its switch above and copy again.',
  '使用 Cloudflare 时，在其速率限制规则里填同样的阈值即可。':
    'On Cloudflare, enter the same thresholds in its rate limiting rules.',

  '当前状态': 'Current status',
  '浏览器端计数每分钟自动收敛。': 'Browser-side counters settle automatically every minute.',
  '解除': 'Clear',
  '页面切换': 'Page switches',
  '请求': 'Requests',
  '站点标签页': 'Site tabs',
  '已触发限制': 'Limit triggered',
  '正常': 'Normal',
  '当前标签页被限制': 'This tab is limited',
  '剩余约 {seconds} 秒。点击「解除」可以立即清空当前标签页的状态。':
    'About {seconds} seconds left. Choose “Clear” to reset this tab right away.',
  '这些计数只属于当前标签页。其它标签页各自计数；并发页面由标签心跳汇总。':
    'These counters belong to this tab only. Other tabs count on their own; concurrent tabs are summed up from tab heartbeats.',

  '恢复默认限制': 'Restore default limits',
  '关闭浏览器端保护，并把三条规则恢复为初始值。不会删除文章、账户或评论。':
    'Turns browser-side protection off and resets the three rules to their initial values. No articles, accounts, or comments are deleted.',
  '恢复默认': 'Restore defaults',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '管理后台请求不受这些限制影响': 'Dashboard requests are not affected by these limits',
};

export default fragment;
