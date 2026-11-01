import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Performance.tsx` */
const fragment: Dictionary = {
  '性能优化': 'Performance',
  '数据库连接数不合法': 'Invalid database connection counts',
  '空闲连接不能超过最大连接数；API 启动时会拒绝这组环境变量。':
    'Idle connections cannot exceed the maximum number of connections; the API will reject these environment variables at startup.',
  '性能设置已保存': 'Performance settings saved',
  '前台行为立即生效；服务器超时、数据库连接池与网关缓存需要按片段部署后重启。':
    'Front-end behavior takes effect immediately; server timeouts, the database connection pool, and gateway caching need the snippets deployed and a restart.',
  '已恢复默认性能设置': 'Default performance settings restored',
  '前台请求量与缓存回到稳妥默认值。':
    'Front-end request volume and caching are back to safe defaults.',
  '站点管理员': 'Site admin',
  '目标不是让动画更快，而是减少 API 查询、重复请求与静态资源占用，让服务器在高峰时':
    'The goal is not faster animations but fewer API queries, duplicate requests, and static assets, so the server can still keep up',
  '仍能及时响应。浏览器侧设置立即生效；服务器超时、连接池与网关缓存会生成部署片段。':
    'at peak load. Browser-side settings apply immediately; server timeouts, the connection pool, and gateway caching produce deployment snippets.',
  '访问限制': 'Access limits',
  '先减少请求，再谈压缩与缓存': 'Cut requests first, then compression and caching',
  '首页每次打开会读取文章与帖子各一次；把首屏条数调小、开启请求去重，可以直接减少':
    'Every home page view reads articles and posts once each; lowering the first-screen count and turning on request deduplication directly cuts',
  'API 与数据库压力。服务器参数需要写入': 'API and database pressure. Server settings go into',
  '并重启 API；': 'and restart the API;',
  '网关参数需要合并进 Nginx 或云 WAF。本页不会自动修改服务器。':
    'gateway settings must be merged into Nginx or a cloud WAF. This page never changes the server for you.',
  '请求量与首屏负载': 'Request volume and first-screen load',
  '减少每次页面访问读取的数据量，直接影响 API 与数据库的响应时间。':
    'Reading less data on each page view directly cuts API and database response time.',
  '推荐优先调整': 'Adjust this first',
  '首页一次读取': 'Home feed per load',
  '文章与帖子各取这么多条；组件多时建议 12–24。':
    'That many articles and that many posts; 12–24 is recommended on pages with many components.',
  '条': 'items',
  '归档页每页': 'Archive page size',
  '归档页分页大小；越小首屏越快，翻页次数越多。':
    'Page size for the archive; smaller renders faster but means more pages.',
  '合并重复请求并短缓存': 'Merge duplicate requests and cache briefly',
  '同一路径的 GET 并发只发一次，短时间内重复打开直接复用结果；写入或切换账户后自动失效。':
    'Concurrent GETs on the same path go out once, and reopening soon after reuses the result; any write or account switch invalidates it.',
  '缓存时长': 'Cache duration',
  '太短起不到减压作用，太长会让列表更新延迟。':
    'Too short and it does not relieve pressure; too long and lists update late.',
  '秒': 'sec',
  '媒体懒加载': 'Lazy-load media',
  '视频只在播放时读取，图片和嵌入站点进入视口才加载，降低首屏带宽。':
    'Videos load only when played, and images and embeds load when they enter the viewport, cutting first-screen bandwidth.',
  '减少前台动效': 'Reduce front-end motion',
  '关闭入场动画与过渡，降低低端设备的渲染压力；系统「减少动态效果」设置始终优先生效。':
    'Turns off entrance animations and transitions to ease rendering on low-end devices; the system Reduce motion setting always wins.',
  '预连接外部资源': 'Preconnect external resources',
  '图片、字体或 CDN 在别的域名时，提前建立连接可以降低首屏等待。':
    'When images, fonts, or a CDN live on another domain, connecting early shortens the first-screen wait.',
  '{count} 个来源': { one: '1 source', other: '{count} sources' },
  '外部来源': 'External sources',
  '一行一个 origin，例如 https://cdn.example.com；只保留 http(s)，最多 8 个。':
    'One origin per line, for example https://cdn.example.com; only http(s) is kept, up to 8.',
  '静态资源与网关缓存': 'Static assets and gateway cache',
  '用于自建 Nginx 的压缩、缓存与超时参数；内置启动器已处理静态资源缓存。':
    'Compression, caching, and timeout settings for your own Nginx; the bundled launcher already caches static assets.',
  '需部署': 'Needs deployment',
  '网关开启 gzip': 'Enable gzip at the gateway',
  '压缩 JS/CSS/JSON/SVG，减少传输时间；HTTPS 下应同时开启 gzip_vary。':
    'Compresses JS/CSS/JSON/SVG to cut transfer time; with HTTPS you should also enable gzip_vary.',
  '静态资源缓存': 'Static asset cache',
  '带 hash 的 assets 可以放心长缓存。':
    'Hashed assets are safe to cache for a long time.',
  '天': 'days',
  '过大占用连接，过小会频繁重连。':
    'Too large ties up connections; too small reconnects constantly.',
  '请求体上限': 'Max request body',
  '上传图片/附件需要足够空间，但过大会放大内存占用。':
    'Uploading images and attachments needs room, but a very large limit inflates memory use.',
  '代理读超时': 'Proxy read timeout',
  '避免慢请求长期占用 worker。': 'Keeps slow requests from occupying a worker.',
  'API 与数据库连接': 'API and database connections',
  '服务器参数；写入 .env 后重启 API。0 表示沿用驱动默认。':
    'Server settings; write them to .env then restart the API. 0 keeps the driver default.',
  '需重启 API': 'Needs an API restart',
  'API 读超时': 'API read timeout',
  '慢请求不能无限占用连接。': 'Slow requests must not hold a connection forever.',
  'API 空闲超时': 'API idle timeout',
  '空闲 keep-alive 连接保留时长。': 'How long idle keep-alive connections are kept.',
  '数据库最大连接': 'Max database connections',
  '0 表示驱动默认：SQLite 1，MySQL/Postgres 25。':
    '0 keeps the driver default: 1 for SQLite, 25 for MySQL/Postgres.',
  '个': 'connections',
  '数据库空闲连接': 'Idle database connections',
  '0 表示驱动默认；通常不超过最大连接数。':
    '0 keeps the driver default; usually not more than the maximum.',
  '连接生命周期': 'Connection lifetime',
  '0 表示不主动回收；默认 1800 秒。':
    '0 disables active recycling; the default is 1800 seconds.',
  '空闲连接不能超过最大连接数': 'Idle connections cannot exceed the maximum',
  'API 启动时会拒绝这组配置。请先调小空闲连接，或把最大连接数调大。':
    'The API rejects this configuration at startup. Lower the idle connections first, or raise the maximum.',
  'SQLite 通常只需要一个连接': 'SQLite usually needs just one connection',
  '内置的 SQLite 模式默认只开一个连接，避免并发写入变成「database is locked」。':
    'The built-in SQLite mode opens a single connection by default so concurrent writes do not end up as "database is locked".',
  '除非你很清楚自己在调什么，否则保持 0 即可。':
    'Unless you know exactly what you are tuning, leave it at 0.',
  '部署片段': 'Deployment snippets',
  '按已保存的设置生成；复制后按实际路径、证书和数据库类型调整。':
    'Generated from the saved settings; after copying, adjust the paths, certificates, and database type.',
  '复制 Nginx': 'Copy Nginx',
  '复制 API .env': 'Copy API .env',
  '展开 API 与数据库环境变量': 'Show API and database environment variables',
  '当前效果': 'Current effect',
  '保存后立即反映到前台。': 'Shown on the site as soon as you save.',
  '首页读取': 'Home feed',
  '{count} 条 × 2': '{count} items × 2',
  '请求缓存': 'Request cache',
  '{count} 秒': '{count} sec',
  '媒体': 'Media',
  '懒加载': 'Lazy loading',
  '立即加载': 'Eager loading',
  '动效': 'Motion',
  '已减少': 'Reduced',
  '跟随系统': 'Follow system',
  'API 超时': 'API timeout',
  '数据库连接': 'Database connections',
  '驱动默认': 'Driver default',
  '配置请求限制': 'Configure request limits',
  '加载动画': 'Loading animation',
  '部署顺序': 'Order of deployment',
  '从影响最大的开始。': 'Start with the biggest win.',
  '先在「访问限制」打开每 IP 请求限制，挡住异常流量。':
    'First turn on the per-IP request limit in Access limits to block abnormal traffic.',
  '调小首屏读取并开启请求去重，减少 API 与数据库压力。':
    'Lower the first-screen read count and turn on request deduplication to ease API and database pressure.',
  '部署 Nginx 压缩与静态缓存，减少带宽与响应时间。':
    'Deploy Nginx compression and static caching to cut bandwidth and response time.',
  '最后按服务器规格调整 HTTP 超时与数据库连接池。':
    'Finally tune HTTP timeouts and the database connection pool to match the server.',
  '恢复默认性能设置': 'Restore default performance settings',
  '回到稳妥默认值；不会改变访问限制、域名或加载动画。':
    'Back to safe defaults; access limits, domains, and the loading animation are untouched.',
  '恢复默认': 'Restore defaults',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
};

export default fragment;
