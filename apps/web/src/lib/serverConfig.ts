import type { AccessSettings, DomainSettings, PerformanceSettings } from '../types';
import { DEFAULT_TLS, boundDomains, defaultCorsOrigins, normalizeDomain } from './domains';
import { t } from './i18n';

/**
 * 把后台里的访问限制、域名与性能设置翻译成可直接部署的片段。
 *
 * 这些文本不会被自动写入服务器：真实部署可能用 Nginx、Caddy、Cloudflare 或
 * 云厂商 WAF。后台只保证数值一致、复制即可用，并明确标注哪些规则属于
 * 浏览器端、哪些属于网关。
 */

function ratePerMinute(access: AccessSettings): number {
  const rule = access.requests;
  return Math.max(1, Math.round((rule.limit * 60) / rule.window_seconds));
}

function primaryHost(domains: DomainSettings, siteDomain?: string): string {
  return normalizeDomain(siteDomain) || normalizeDomain(domains.primary);
}

export function buildAccessEnvSnippet(
  access: AccessSettings,
  domains?: DomainSettings,
): string {
  const lines = [
    t('# 由 Practacu Press「站点设置 → 访问限制」生成'),
    t('# 复制到 API 的 .env 后重启服务；浏览器端限制不能替代这里'),
    '',
  ];
  lines.push(
    access.requests.enabled
      ? `RATE_LIMIT_PER_MINUTE=${ratePerMinute(access)}`
      : 'RATE_LIMIT_PER_MINUTE=0',
  );
  if (!access.requests.enabled) {
    lines.push(t('# 上面的 0 表示关闭 API 的每 IP 每分钟请求限制'));
  }
  if (domains) {
    const proxies = domains.trusted_proxies.filter(Boolean);
    lines.push(`TRUSTED_PROXIES=${proxies.join(',') || ''}`);
    lines.push(t('# 只有来自这些地址的 X-Forwarded-For / X-Real-IP 才会被相信'));
  }
  return lines.join('\n');
}

function tlsDirectives(domains: DomainSettings, primary: string): string[] {
  const tls = domains.tls ?? DEFAULT_TLS;
  const out: string[] = [];
  if (tls.mode === 'letsencrypt') {
    out.push(`  ssl_certificate     /etc/letsencrypt/live/${primary || t('<主域名>')}/fullchain.pem;`);
    out.push(`  ssl_certificate_key /etc/letsencrypt/live/${primary || t('<主域名>')}/privkey.pem;`);
  } else if (tls.mode === 'manual') {
    out.push(`  ssl_certificate     ${tls.cert_path || '/etc/ssl/certs/fullchain.pem'};`);
    out.push(`  ssl_certificate_key ${tls.key_path || '/etc/ssl/private/privkey.pem'};`);
  } else {
    out.push(
      `  ${t("# 证书路径按实际部署填写，或在「访问与域名 → SSL 证书」里选择 Let's Encrypt / 手动证书")}`,
    );
    out.push(`  # ssl_certificate     /etc/letsencrypt/live/${primary || t('<主域名>')}/fullchain.pem;`);
    out.push(`  # ssl_certificate_key /etc/letsencrypt/live/${primary || t('<主域名>')}/privkey.pem;`);
  }
  out.push('  ssl_protocols TLSv1.2 TLSv1.3;');
  out.push('  ssl_prefer_server_ciphers off;');
  if (tls.hsts) {
    out.push('  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
  }
  return out;
}

export function buildGatewaySnippet(
  access: AccessSettings,
  domains: DomainSettings,
  siteDomain?: string,
): string {
  const names = boundDomains(domains, siteDomain);
  const primary = primaryHost(domains, siteDomain);
  const hasDomain = names.length > 0;
  const tls = domains.tls ?? DEFAULT_TLS;
  const https = tls.mode !== 'off' || domains.https_only;
  const apiRate = ratePerMinute(access);
  const apiBurst = Math.max(1, Math.round(access.requests.limit / 4));
  const pageRate = Math.max(
    1,
    Math.round((access.page_switch.limit * 60) / access.page_switch.window_seconds),
  );
  const pageBurst = Math.max(1, Math.round(access.page_switch.limit / 2));
  // 浏览器一个标签会为文档、脚本、样式、图片开多条连接；按每页约 4 条估算，
  // 否则 limit_conn 会把正常的单页访问挡掉。
  const connLimit = Math.max(4, access.tabs.limit * 4);
  const serverName = hasDomain ? names.join(' ') : '_';
  const serverBody: string[] = [`  server_name ${serverName};`];
  if (hasDomain && domains.redirect_primary && names.length > 1) {
    serverBody.push(`  if ($host != ${primary}) { return 301 https://${primary}$request_uri; }`);
  }
  if (!hasDomain) {
    serverBody.push(`  ${t('# 未设置主域名：只允许公网 IP 直接访问；私有 IP 与域名 Host 一律拒绝。')}`);
    serverBody.push(`  ${t('# 本机管理仍可通过 localhost 访问（仅限服务器本机）。')}`);
    serverBody.push(`  if ($host !~* "^[0-9a-fA-F:.]+$") { return 444; }`);
  }
  serverBody.push(`  ${t('# 静态文件目录；按实际构建产物位置改写')}`);
  serverBody.push('  root /var/www/practacu/dist;');
  serverBody.push('');
  if (hasDomain) {
    serverBody.push(`  ${t('# 多个域名共用同一个站点时，统一把 Host 改写为主域名；')}`);
    serverBody.push(`  ${t('# 否则 API 的按域名解析会把别名当成未知站点。')}`);
    serverBody.push(`  proxy_set_header Host ${primary};`);
  } else {
    serverBody.push(`  ${t('# 没有主域名：把原始 Host（公网 IP）原样转给 API。')}`);
    serverBody.push('  proxy_set_header Host $host;');
  }
  serverBody.push('  proxy_set_header X-Real-IP $remote_addr;');
  serverBody.push('  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  serverBody.push('  proxy_set_header X-Forwarded-Proto $scheme;');
  serverBody.push('');

  if (access.tabs.enabled) {
    serverBody.push(
      `  ${t('# 并发页面上限 {count} 个 × 约 4 条连接/页', { count: access.tabs.limit })}`,
    );
    serverBody.push(`  limit_conn pp_conn ${connLimit};`);
  } else {
    serverBody.push(`  ${t('# 并发页面上限未启用，未生成 limit_conn')}`);
  }

  serverBody.push('');
  serverBody.push(`  ${t('# API 请求限制只作用在 /api/，避免把正常的静态资源请求算进去。')}`);
  serverBody.push('  location /api/ {');
  if (access.requests.enabled) {
    serverBody.push(`    limit_req zone=pp_api burst=${apiBurst} nodelay;`);
  }
  serverBody.push('    proxy_pass http://127.0.0.1:8080;');
  serverBody.push('  }');
  serverBody.push('');
  serverBody.push(`  ${t('# 带 hash 的静态资源不参与页面计数，避免一次加载消耗掉页面额度。')}`);
  serverBody.push('  location /assets/ {');
  serverBody.push('    try_files $uri =404;');
  serverBody.push('    expires 365d;');
  serverBody.push('    add_header Cache-Control "public, immutable";');
  serverBody.push('  }');
  serverBody.push('');
  serverBody.push(`  ${t('# 页面文档请求：SPA 的站内切换不经过服务器，这里限制的是硬加载。')}`);
  serverBody.push(`  ${t('# 静态文件由 Nginx 直接读取，只有 API 代理到 Go 服务。')}`);
  serverBody.push('  location / {');
  if (access.page_switch.enabled) {
    serverBody.push(`    limit_req zone=pp_page burst=${pageBurst} nodelay;`);
  }
  serverBody.push('    try_files $uri $uri/ /index.html;');
  serverBody.push('  }');
  serverBody.push('}');

  const lines: string[] = [
    t('# 由 Practacu Press 生成。数值与「访问限制」页一致。'),
    t('# http {} 层：'),
  ];
  if (access.requests.enabled) {
    lines.push(`limit_req_zone $binary_remote_addr zone=pp_api:10m rate=${apiRate}r/m;`);
  }
  if (access.page_switch.enabled) {
    lines.push(`limit_req_zone $binary_remote_addr zone=pp_page:10m rate=${pageRate}r/m;`);
  }
  if (access.tabs.enabled) {
    lines.push('limit_conn_zone $binary_remote_addr zone=pp_conn:10m;');
  }
  lines.push('');

  // 有域名时先放一个默认 server 拒绝其它 Host，避免别人把域名指过来就能读到站点。
  if (hasDomain) {
    lines.push('server {', '  listen 80 default_server;', '  server_name _;', '  return 444;', '}');
    if (https) {
      lines.push('', 'server {', '  listen 443 ssl default_server;', '  server_name _;');
      lines.push(...tlsDirectives(domains, primary));
      lines.push('  return 444;', '}');
    }
    lines.push('');
  }

  if (https) {
    lines.push('server {', '  listen 80;', `  server_name ${serverName};`);
    lines.push(`  ${t('# 所有明文请求跳到 HTTPS（证书在下方 443 块里）')}`);
    lines.push('  return 301 https://$host$request_uri;');
    lines.push('}', '');
    lines.push('server {', '  listen 443 ssl http2;');
    lines.push(...tlsDirectives(domains, primary));
    lines.push(...serverBody);
  } else {
    lines.push('server {', '  listen 80;');
    lines.push(...serverBody);
  }
  return lines.join('\n');
}

/** 证书申请/部署提示；不包含私钥内容，只给命令与路径。 */
export function buildTlsSetupSnippet(domains: DomainSettings, siteDomain?: string): string {
  const primary = primaryHost(domains, siteDomain);
  const tls = domains.tls ?? DEFAULT_TLS;
  const lines = [t('# TLS 证书配置（按实际服务器调整）'), ''];
  if (tls.mode === 'letsencrypt') {
    lines.push(t('# 1. 安装 certbot（Debian/Ubuntu）'));
    lines.push('apt-get update && apt-get install -y certbot python3-certbot-nginx');
    lines.push('');
    lines.push(t('# 2. 申请证书：DNS 需先指向本机'));
    lines.push(
      `certbot certonly --nginx -d ${primary || t('<主域名>')} --email ${tls.email || t('<邮箱>')} --agree-tos --no-eff-email`,
    );
    lines.push('');
    lines.push(t('# 3. 证书路径（Nginx 片段已引用）'));
    lines.push(`# /etc/letsencrypt/live/${primary || t('<主域名>')}/fullchain.pem`);
    lines.push(`# /etc/letsencrypt/live/${primary || t('<主域名>')}/privkey.pem`);
    lines.push(t('# 续期：certbot renew --dry-run'));
  } else if (tls.mode === 'manual') {
    lines.push(t('# 已有证书：确认 Nginx 进程可读取以下文件'));
    lines.push(t('# 证书链：{path}', { path: tls.cert_path || '/etc/ssl/certs/fullchain.pem' }));
    lines.push(t('# 私钥：{path}', { path: tls.key_path || '/etc/ssl/private/privkey.pem' }));
    lines.push(t('# 私钥只放在服务器上，不要提交到 Git 或写进浏览器配置。'));
  } else {
    lines.push(t('# 当前未启用 TLS。在「访问与域名 → SSL 证书」里选择 Let’s Encrypt 或手动证书。'));
    lines.push(t('# 也可以在前面挂 Caddy / Cloudflare 终止 TLS，再把 HTTP 回源到本站。'));
  }
  return lines.join('\n');
}

export function buildDomainEnvSnippet(
  domains: DomainSettings,
  siteDomain?: string,
): string {
  const primary = primaryHost(domains, siteDomain);
  const origins = defaultCorsOrigins(domains, siteDomain);
  const tls = domains.tls ?? DEFAULT_TLS;
  const scheme = tls.mode !== 'off' || domains.https_only ? 'https' : 'http';
  const lines = [
    t('# 由 Practacu Press「站点设置 → 访问与域名」生成'),
    t('# 复制到 API 的 .env 后重启服务'),
    '',
  ];
  lines.push(
    primary
      ? `PUBLIC_BASE_URL=${scheme}://${primary}`
      : `${t('# 还没有设置主域名：生产环境只允许公网 IP 直连')}\n# PUBLIC_BASE_URL=http://${t('<服务器公网IP>')}`,
  );
  if (domains.cookie_domain.trim()) {
    lines.push(`COOKIE_DOMAIN=${domains.cookie_domain.trim()}`);
  } else {
    lines.push('# COOKIE_DOMAIN=.example.com');
    lines.push(t('# 只有多个子域名需要共享登录态时才填写父域'));
  }
  lines.push(`CORS_ALLOWED_ORIGINS=${origins.join(',') || ''}`);
  if (origins.length) {
    lines.push('CORS_ALLOW_CREDENTIALS=true');
  }
  lines.push(`TRUSTED_PROXIES=${domains.trusted_proxies.join(',') || ''}`);
  lines.push('');
  lines.push(t('# 浏览器直接访问别名域名时，反向代理需把 Host 改写成主域名；'));
  lines.push(t('# 页面上方生成的 Nginx 片段已经包含这一行。'));
  return lines.join('\n');
}

/** API 的超时与数据库连接池；需要写入 .env 并重启 API。 */
export function buildPerformanceEnvSnippet(performance: PerformanceSettings): string {
  return [
    t('# 由 Practacu Press「性能优化 → 服务器连接」生成'),
    t('# 复制到 API 的 .env 后重启服务；浏览器端设置不需要这一步'),
    '',
    `HTTP_READ_TIMEOUT_SECONDS=${performance.api_read_timeout}`,
    `HTTP_IDLE_TIMEOUT_SECONDS=${performance.api_idle_timeout}`,
    '',
    t('# 0 表示沿用驱动默认：SQLite 1 个连接，MySQL/Postgres 25 个'),
    `DB_MAX_OPEN_CONNS=${performance.db_max_open_conns}`,
    `DB_MAX_IDLE_CONNS=${performance.db_max_idle_conns}`,
    t('# 0 表示不主动回收；默认 1800 秒'),
    `DB_CONN_MAX_LIFETIME_SECONDS=${performance.db_conn_max_lifetime}`,
  ].join('\n');
}

/** 反向代理层的压缩、缓存与超时；需要按实际部署合并进 Nginx。 */
export function buildPerformanceGatewaySnippet(performance: PerformanceSettings): string {
  const lines = [
    t('# 由 Practacu Press「性能优化」生成'),
    t('# 内置启动器已对带 hash 的资源设置长缓存；公网部署时把以下规则合并进 Nginx。'),
    '',
    t('# http {} 层'),
    `keepalive_timeout ${performance.keepalive_timeout}s;`,
    `client_max_body_size ${performance.client_max_body_size_mb}m;`,
  ];
  if (performance.gzip) {
    lines.push('gzip on;');
    lines.push('gzip_vary on;');
    lines.push(
      'gzip_types text/css application/javascript application/json image/svg+xml text/plain;',
    );
  } else {
    lines.push('gzip off;');
  }
  lines.push('');
  lines.push('server {');
  lines.push(`  ${t('# server_name 与实际绑定域名一致')}`);
  lines.push('  root /var/www/practacu/dist;');
  lines.push('  location /assets/ {');
  lines.push('    try_files $uri =404;');
  lines.push(`    expires ${performance.static_cache_days}d;`);
  lines.push('    add_header Cache-Control "public, immutable";');
  lines.push('  }');
  lines.push('  location = /index.html {');
  lines.push('    add_header Cache-Control "no-store";');
  lines.push('  }');
  lines.push('  location / {');
  lines.push('    try_files $uri $uri/ /index.html;');
  lines.push('  }');
  lines.push('  location /api/ {');
  lines.push('    proxy_pass http://127.0.0.1:8080;');
  lines.push(`    proxy_read_timeout ${performance.proxy_read_timeout}s;`);
  lines.push('    proxy_http_version 1.1;');
  lines.push('    proxy_set_header Connection "";');
  lines.push('    proxy_set_header Host $host;');
  lines.push('    proxy_set_header X-Real-IP $remote_addr;');
  lines.push('    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  lines.push('    proxy_set_header X-Forwarded-Proto $scheme;');
  lines.push('  }');
  lines.push('}');
  if (performance.preconnect.length) {
    lines.push('');
    lines.push(t('# 页面会为这些来源注入 preconnect：'));
    for (const origin of performance.preconnect) lines.push(`# ${origin}`);
  }
  return lines.join('\n');
}
