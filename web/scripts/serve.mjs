#!/usr/bin/env node
/**
 * Practacu Press 静态站点服务器。
 *
 * - 默认监听 8080 端口（启动器与生产打包也用这个默认值）；
 * - 端口可以在管理后台「站点设置 → 访问端口」里热切换，不需要重启进程；
 * - 选定的端口写入 web/.runtime/web.json，下次启动沿用。
 *
 * 用法：
 *   npm start                  # 默认 8080
 *   npm start -- --port 9090   # 临时换一个端口
 *   PP_WEB_PORT=8081 npm start # 也可以用环境变量
 *
 * 只做静态文件与运行时端口接口；/api 仍然交给反向代理或 Go API，
 * 这里会明确返回 JSON 404，避免 SPA 的 HTML 回退被误判成后端可用。
 *
 * 另外提供 `GET /__pp/update`：服务端读取版本清单（`version.json`）并与本机版本比较。
 * 它和启动器的同名接口行为一致，这样 `npm start` 起的站点也能检查更新。
 *
 * 内容页元数据（Beta 1.2）：`/a/:id`、`/p/:id` 的 HTML 请求不再直接返回裸外壳，
 * 而是先向 API 取一次内容元数据，把 title / description / Open Graph / canonical
 * 注入 `dist/index.html` 后再返回，社交抓取器（微信 / X / Telegram）于是能拿到真实
 * 卡片。API 基地址解析顺序：
 *
 *   1. 环境变量 `PP_API_BASE`（例如 `http://127.0.0.1:8080`）
 *   2. 默认 `http://127.0.0.1:8080`
 *
 * 注意这两者是「约定」而不是「发现」：API 换了端口（`deploy/linux/install.sh` 默认
 * 把 API 放在 8081）就要显式给 `PP_API_BASE`，否则取不到元数据——站点照旧能打开，
 * 只是退回默认分享卡片。缓存 60 秒、单次超时 800ms，都是下面的常量。
 *
 * 请求透传原始 Host 头——API 按 Host 解析站点。取元数据失败、超时或 404 一律原样
 * 返回 index.html，站点不会因为 API 挂掉而打不开（细节见下面的「内容页元数据注入」段）。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const RUNTIME_DIR = resolve(fileURLToPath(new URL('../.runtime/', import.meta.url)));
const RUNTIME_FILE = join(RUNTIME_DIR, 'web.json');
const DEFAULT_PORT = 8080;
const STARTED_AT = new Date().toISOString();

const HOSTS = process.env.PP_WEB_HOST
  ? [process.env.PP_WEB_HOST]
  : ['127.0.0.1', '::1'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return 'localhost';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

function protocolOf(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' ? 'https' : 'http';
}

/** 由请求的 Host 头 + 目标端口拼出新的访问地址（80/443 省略端口号）。 */
function originFor(req, port) {
  const proto = protocolOf(req);
  const host = hostnameOf(req.headers.host);
  const fallback = proto === 'https' ? 443 : 80;
  return `${proto}://${host}${port === fallback ? '' : `:${port}`}`;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 控制面只接受本机地址栏的 Host。
 *
 * 只检查来源地址不够：DNS rebinding 会让浏览器把恶意域名解析到 127.0.0.1，
 * 此时 remoteAddress 是回环地址，但 Host/Origin 都是攻击者的域名（两者相等，
 * 同源检查也通过）。控制面接口（端口修改、状态导出、更新检查、运行时信息）
 * 因此还必须确认 Host 本身就是 localhost / 127.0.0.1 / [::1]。
 */
function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const host = hostnameOf(hostHeader).toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function readBody(req, limit = 2048) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

async function sendFile(req, res, filePath) {
  const info = await stat(filePath);
  const ext = extname(filePath).toLowerCase();
  const isAsset = filePath.includes(`${sep}assets${sep}`);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': isAsset
      ? 'public, max-age=31536000, immutable'
      : ext === '.html'
        ? 'no-store'
        : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function savePort(port) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(
    RUNTIME_FILE,
    `${JSON.stringify({ port, updated_at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

async function readSavedPort() {
  try {
    const parsed = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'));
    return Number(parsed?.port) || 0;
  } catch {
    return 0;
  }
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0;
  return port;
}

/* ---------------- 版本清单与更新检查 ---------------- */

/** 构建产物里的版本清单；`public/version.json` 会被原样复制进 dist。 */
const LOCAL_MANIFEST = 'version.json';

/** 默认更新源：仓库里的清单（与启动器、前端下拉栏里的第一项一致）。 */
const DEFAULT_UPDATE_SOURCE =
  'https://raw.githubusercontent.com/practacu/practacu-press/main/web/public/version.json';

/**
 * 允许服务端去抓的主机。
 *
 * 页面只能选下拉栏里的地址，但还是校验一次：这个接口会把请求发到外部，
 * 不设白名单就等于给了页面一个任意地址的代理。
 */
const UPDATE_ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'cdn.jsdelivr.net',
  'gitee.com',
]);

const MANIFEST_LIMIT = 64 * 1024;
const MANIFEST_TIMEOUT_MS = 3000;
const VERSION_PATTERN = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const UPDATE_STYLES = new Set(['stable', 'beta', 'local']);

/** 解析版本清单：四个核心字段缺一不可，版本号与渠道都要合法。 */
function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const describe = typeof value.describe === 'string' ? value.describe.trim() : '';
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  const style = typeof value.style === 'string' ? value.style.trim() : '';
  if (!title || !describe || !version) return null;
  if (!VERSION_PATTERN.test(version)) return null;
  if (!UPDATE_STYLES.has(style)) return null;
  return { title, describe, version, style };
}

/**
 * 去掉开头的 UTF-8 BOM。
 *
 * Windows 上 PowerShell 5.1 的 `Set-Content -Encoding utf8` 与部分编辑器会写 BOM，
 * 而 `JSON.parse` / `encoding/json` 遇到它会直接报「不是合法 JSON」。这一个字节
 * 不值得让手工改过清单的人看到「版本清单无效」，所以读文本时统一剥掉。
 */
function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

/** 版本号拆成三段数字 + 预发布标签；非法返回 null。 */
function versionParts(version) {
  const match = VERSION_PATTERN.exec(String(version).trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.').filter(Boolean) : [],
  };
}

/** 语义版本比较：a>b 返回正数，相等 0，无法解析按相等处理。 */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

/** 读本机清单：构建产物里的 `version.json`。 */
async function readLocalManifest() {
  try {
    const parsed = JSON.parse(stripBom(await readFile(join(DIST, LOCAL_MANIFEST), 'utf8')));
    return parseManifest(parsed);
  } catch {
    return null;
  }
}

/**
 * 服务端抓取远端清单。
 *
 * 只接受 https + 白名单主机；请求带 3 秒超时与 64 KiB 上限，避免更新源把静态服务拖住。
 */
async function fetchRemoteManifest(source) {
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return { error: 'validation_failed', status: 400, message: '更新源地址不合法。' };
  }
  if (parsed.protocol !== 'https:' || !UPDATE_ALLOWED_HOSTS.has(parsed.hostname)) {
    return { error: 'permission_denied', status: 403, message: '这个更新源不在允许的名单里。' };
  }
  let res;
  try {
    res = await fetch(source, {
      headers: { Accept: 'application/json', 'User-Agent': 'practacu-press-static' },
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { error: 'upstream_timeout', status: 504, message: '读取更新源超时，请稍后重试。' };
    }
    return { error: 'upstream_failed', status: 502, message: '无法连接更新源。' };
  }
  if (!res.ok) {
    return {
      error: 'upstream_failed',
      status: 502,
      message: `更新源返回了 HTTP ${res.status}。`,
    };
  }
  let text;
  try {
    text = await res.text();
  } catch {
    return { error: 'upstream_failed', status: 502, message: '读取更新源失败。' };
  }
  if (text.length > MANIFEST_LIMIT) {
    return { error: 'upstream_failed', status: 502, message: '版本清单超出大小上限。' };
  }
  let manifest = null;
  try {
    manifest = parseManifest(JSON.parse(stripBom(text)));
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return { error: 'upstream_failed', status: 502, message: '更新源返回的不是有效的版本清单。' };
  }
  return { manifest };
}

/** `GET /__pp/update?source=…`：服务端读清单并与本机版本比较。 */
async function handleUpdateCheck(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { code: 'method_not_allowed', message: '只支持 GET。' });
    return;
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { code: 'permission_denied', message: '只能在运行站点的这台电脑上检查更新。' });
    return;
  }
  const source = String(url.searchParams.get('source') || '').trim() || DEFAULT_UPDATE_SOURCE;

  let remote;
  if (source.startsWith('/')) {
    // 本站自己的清单：直接读构建产物，不走网络。
    if (source !== `/${LOCAL_MANIFEST}`) {
      sendJson(res, 400, { code: 'validation_failed', message: '本地更新源只能是 /version.json。' });
      return;
    }
    remote = await readLocalManifest();
    if (!remote) {
      sendJson(res, 404, { code: 'not_found', message: '构建产物里没有可用的 version.json。' });
      return;
    }
  } else {
    const fetched = await fetchRemoteManifest(source);
    if (fetched.error) {
      sendJson(res, fetched.status, { code: fetched.error, message: fetched.message });
      return;
    }
    remote = fetched.manifest;
  }

  const local = await readLocalManifest();
  const order = local ? compareVersions(remote.version, local.version) : 1;
  const reason = !local ? 'unknown' : order > 0 ? 'newer' : order < 0 ? 'older' : 'same';
  sendJson(res, 200, {
    ok: true,
    source,
    fetched_at: new Date().toISOString(),
    ...(local ? { local } : {}),
    remote,
    update_available: order > 0,
    reason,
  });
}


/* ---------------- 内容页元数据注入（爬虫可读的 SPA 外壳） ---------------- */

/**
 * 社交平台的抓取器不执行 JS，只会读 HTML 源码。SPA 外壳里因此只有站点默认卡片，
 * 分享出去的每一篇都长一个样。这里在返回外壳之前补一次内容元数据。
 *
 * 三条硬要求（改动这段之前先读一遍）：
 *
 *   1. **失败即降级**：API 超时、非 200、JSON 不合法、index.html 读不到——任何一种
 *      都原样返回 index.html。静态服务不能因为 API 挂了就把网站关掉。
 *   2. **有缓存**：结果按 `(Host, 路径)` 缓存 `SEO_CACHE_TTL_MS`（60 秒），正常访问
 *      不会每个请求都打 API。失败结果同样缓存，否则 API 挂掉时每个请求都要白等
 *      一次 800ms 超时，比拿到默认卡片更糟。
 *   3. **一律转义**：注入的每个值都过 `escapeHtml`，标题里有 `"` `<` `&` 也破坏不了
 *      属性；只往标签里塞文本，不拼任何 HTML 片段。
 *
 * API 基地址：`PP_API_BASE` → 默认 `http://127.0.0.1:8080`（见文件头部注释）。
 * Host 头原样透传，因为 API 靠它解析站点；协议用 `X-Forwarded-Proto`（反向代理后面
 * 才可能是 https），拼 canonical 与 og:url 时用得到。
 *
 * 边界：只处理 `Accept` 里带 `text/html` 的 GET 导航请求——读者与主流抓取器都这么发。
 * 少数只把 `Accept` 设成星号通配的老抓取器仍按改动前的行为拿到 404（它们本来也拿不到外壳）。
 */

/** API 基地址：没配置 `PP_API_BASE` 时假设 API 在本机默认端口。 */
const DEFAULT_API_BASE = 'http://127.0.0.1:8080';

/** 外壳缓存时长：60 秒。改内容后最多一分钟，抓取器就能看到新的卡片。 */
const SEO_CACHE_TTL_MS = 60 * 1000;

/** 单次元数据请求的超时：800ms。超时按失败处理（原样返回外壳）。 */
const SEO_FETCH_TIMEOUT_MS = 800;

/** 缓存条目上限：条目少，淘汰最省事的那条即可，不值得为它上 LRU。 */
const SEO_CACHE_LIMIT = 500;

/** 单次读取的响应体上限；超了就放弃注入（宁可返回默认卡片，也不拖垮内存）。 */
const SEO_BODY_LIMIT = 1024 * 1024;

/** 外壳里的元数据占位符；没有占位符时改写同名的既有标签（见 injectMeta）。 */
const META_PLACEHOLDER = '<!--PP_META-->';

/** `/a/:id`（article）与 `/p/:id`（post），允许结尾多一个斜杠。 */
const CONTENT_PATH = /^\/(a|p)\/([^/]+)\/?$/;

/** 注入标签统一带这个标记：页面启动后由 lib/seo.ts 的 clearManaged 接管并替换。 */
const SEO_MARK = ' data-pp-seo="1"';

/**
 * 解析 API 基地址；非法地址返回 null。
 *
 * 返回 null 不是启动失败：所有请求照旧返回原始外壳，只是没有服务端元数据。
 * 这样运维配错一个环境变量不会让站点起不来。
 */
function parseApiBase(value) {
  try {
    const base = new URL(String(value || '').trim());
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    return base;
  } catch {
    return null;
  }
}

const API_BASE = parseApiBase(process.env.PP_API_BASE || DEFAULT_API_BASE);

/** `(Host + 路径)` → `{ html, expires }`，html 是注入好的外壳（失败时就是原样外壳）。 */
const seoShellCache = new Map();

/** HTML 文本转义：注入的每一个值都从这里过。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 合并连续空白：标题/摘要里的换行不该原样进 `<title>`。 */
function collapseSpace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 相对地址补成绝对地址；http(s) 与 data URL 原样返回。 */
function absoluteMetaUrl(value, origin) {
  const url = collapseSpace(value);
  if (!url) return '';
  if (/^(?:https?:|data:)/i.test(url)) return url;
  if (!origin) return url;
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** 请求对外的站点地址：`X-Forwarded-Proto`（没有则 http）+ 原始 Host 头。 */
function publicOrigin(req) {
  const host = String(req.headers.host || '').trim();
  return `${protocolOf(req)}://${host || 'localhost'}`;
}

/** 一个受管理的 meta 标签；`SEO_MARK` 让运行时 SEO 层认得它。 */
function metaTag(attribute, key, value) {
  return `<meta ${attribute}="${key}" content="${escapeHtml(value)}"${SEO_MARK} />`;
}

/** 匹配同名 meta 标签，用于在原位替换（避免外壳里出现两份 og:title）。 */
function metaPattern(attribute, key) {
  return new RegExp(`<meta\\b[^>]*\\b${attribute}=["']${key}["'][^>]*>`, 'gi');
}

function linkPattern(rel) {
  return new RegExp(`<link\\b[^>]*\\brel=["']${rel}["'][^>]*>`, 'gi');
}

/**
 * 把一次 API 响应的内容字段投影成「标签 + 在哪儿替换」的列表。
 *
 * 只读这几个字段，正文（rendered_html）一概不看：这里的目标是分享卡片。
 * 值全部经过 escapeHtml，返回值只用于拼标签、不再被当作 HTML 解析。
 */
function metaTags(content, origin, pathname) {
  const item = content && typeof content === 'object' ? content : {};
  const title = collapseSpace(item.seo_title) || collapseSpace(item.title) || collapseSpace(item.slug);
  const description = (
    collapseSpace(item.seo_description) || collapseSpace(item.summary)
  ).slice(0, 300);
  const canonical = absoluteMetaUrl(item.canonical_url, origin) || `${origin}${pathname}`;
  const image = absoluteMetaUrl(collapseSpace(item.og_image) || collapseSpace(item.cover_url), origin);
  const keywords = collapseSpace(item.seo_keywords);
  const noindex = String(item.robots || '').trim() === 'noindex';

  const tags = [];
  if (title) {
    tags.push({ pattern: /<title>[\s\S]*?<\/title>/gi, tag: `<title>${escapeHtml(title)}</title>` });
  }
  if (description) {
    tags.push({
      pattern: metaPattern('name', 'description'),
      tag: metaTag('name', 'description', description),
    });
  }
  // robots：只有作者明确写了 noindex 才输出，其它情况沿用站点级设置（外壳里本来就有）。
  if (noindex) {
    tags.push({ pattern: metaPattern('name', 'robots'), tag: metaTag('name', 'robots', 'noindex') });
  }
  if (keywords) {
    tags.push({ pattern: metaPattern('name', 'keywords'), tag: metaTag('name', 'keywords', keywords) });
  }
  tags.push({ pattern: metaPattern('property', 'og:type'), tag: metaTag('property', 'og:type', 'article') });
  if (title) {
    tags.push({ pattern: metaPattern('property', 'og:title'), tag: metaTag('property', 'og:title', title) });
  }
  if (description) {
    tags.push({
      pattern: metaPattern('property', 'og:description'),
      tag: metaTag('property', 'og:description', description),
    });
  }
  if (image) {
    tags.push({ pattern: metaPattern('property', 'og:image'), tag: metaTag('property', 'og:image', image) });
  }
  tags.push({ pattern: metaPattern('property', 'og:url'), tag: metaTag('property', 'og:url', canonical) });
  tags.push({
    pattern: metaPattern('name', 'twitter:card'),
    tag: metaTag('name', 'twitter:card', image ? 'summary_large_image' : 'summary'),
  });
  tags.push({
    pattern: linkPattern('canonical'),
    tag: `<link rel="canonical" href="${escapeHtml(canonical)}"${SEO_MARK} />`,
  });
  return tags;
}

/**
 * 把标签塞进外壳。
 *
 * 优先替换 `<!--PP_META-->` 占位符。构建产物里还没有占位符时（`index.html` 目前就
 * 自带一组默认标签），改写同名标签，重复的那几个直接删掉——抓取器只认第一个
 * og:title，留着旧的等于白注入。两种方式插入的标签都带 data-pp-seo，页面启动后
 * 由 lib/seo.ts 统一接管。
 *
 * 替换一律用函数形式的 `String.replace`：标签内容可能含 `$&` 之类的字符，
 * 字符串替换会把它们当成替换模式。
 */
function injectMeta(html, tags) {
  if (!tags.length) return html;
  const block = tags.map((entry) => entry.tag).join('\n    ');
  if (html.includes(META_PLACEHOLDER)) return html.replace(META_PLACEHOLDER, () => block);

  let out = html;
  const leftovers = [];
  for (const { pattern, tag } of tags) {
    let placed = false;
    out = out.replace(pattern, () => {
      if (placed) return '';
      placed = true;
      return tag;
    });
    if (!placed) leftovers.push(tag);
  }
  if (!leftovers.length) return out;
  const tail = leftovers.join('\n    ');
  return /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => `    ${tail}\n  </head>`) : out;
}

/**
 * 读一次内容元数据。**从不抛错**：超时、非 200、坏 JSON、过大都返回 null，
 * 调用方据此原样返回外壳。
 */
function fetchContentMeta(req, kind, id) {
  return new Promise((resolveMeta) => {
    if (!API_BASE) {
      resolveMeta(null);
      return;
    }
    const endpoint = kind === 'a' ? 'articles' : 'posts';
    const prefix = API_BASE.pathname.replace(/\/+$/, '');
    const target = `${API_BASE.origin}${prefix}/api/v1/${endpoint}/${encodeURIComponent(id)}`;
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'practacu-press-static-seo',
      'X-Forwarded-Proto': protocolOf(req),
    };
    // 站点由 Host 解析：必须透传原始 Host，不能让 API 只看到 127.0.0.1:8080。
    const hostHeader = String(req.headers.host || '').trim();
    if (hostHeader) headers.Host = hostHeader;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveMeta(value);
    };

    const request = http.request(
      target,
      { method: 'GET', headers, timeout: SEO_FETCH_TIMEOUT_MS },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
          if (text.length > SEO_BODY_LIMIT) {
            request.destroy();
            finish(null);
          }
        });
        response.on('end', () => {
          try {
            finish(JSON.parse(stripBom(text)));
          } catch {
            finish(null);
          }
        });
        response.on('error', () => finish(null));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
    request.end();
  });
}

/** 读 `dist/index.html`；读不到返回 null（调用方回退到原来的静态分支）。 */
async function readShell() {
  try {
    return await readFile(join(DIST, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}

/** 记一条外壳缓存；超出上限时丢掉最早写入的一条（Map 保持插入顺序）。 */
function rememberShell(key, entry) {
  if (seoShellCache.size >= SEO_CACHE_LIMIT) {
    const oldest = seoShellCache.keys().next().value;
    if (oldest !== undefined) seoShellCache.delete(oldest);
  }
  seoShellCache.set(key, entry);
}

/**
 * 内容页的外壳：命中缓存直接返回，否则取元数据并注入。
 * 返回 null 表示连 index.html 都读不到——调用方按原来的逻辑返回。
 */
async function seoShellFor(req, pathname, kind, id) {
  const key = `${String(req.headers.host || '').toLowerCase()}\n${pathname}`;
  const cached = seoShellCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.html;

  const shell = await readShell();
  if (shell === null) return null;

  const content = await fetchContentMeta(req, kind, id);
  const html = content ? injectMeta(shell, metaTags(content, publicOrigin(req), pathname)) : shell;
  rememberShell(key, { html, expires: Date.now() + SEO_CACHE_TTL_MS });
  return html;
}

/** 返回注入后的外壳；缓存策略与 index.html 一致（不进缓存）。 */
async function sendSeoShell(req, res, pathname, kind, id) {
  const html = await seoShellFor(req, pathname, kind, id);
  if (html === null) {
    await sendFile(req, res, join(DIST, 'index.html'));
    return;
  }
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

let currentPort = DEFAULT_PORT;
let activeServers = [];
let distReady = false;

/**
 * 换端口时浏览器存储会按新地址重新隔离。为了不让用户重装，
 * 页面把 localStorage 里的 pp.* 一起发过来，暂存在内存里一次性交给新地址。
 */
const snapshots = new Map();
const SNAPSHOT_TTL = 2 * 60 * 1000;
const SNAPSHOT_LIMIT = 4 * 1024 * 1024;

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = '/';
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { code: 'bad_request', message: '路径无法解码。' });
    return;
  }

  if (pathname.startsWith('/__pp/')) {
    // The whole __pp control plane is local-only, not just the port change: the
    // runtime endpoint exposes the pid and listener, and the update endpoint reads
    // server-side state. Host validation closes the DNS rebinding path.
    if (!isLoopback(req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host)) {
      sendJson(res, 403, {
        code: 'permission_denied',
        message: '控制接口只允许在本机通过 localhost 访问。',
      });
      return;
    }
  }

  if (pathname === '/__pp/runtime') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { code: 'method_not_allowed', message: '只支持 GET。' });
      return;
    }
    sendJson(res, 200, {
      mode: 'static',
      port: currentPort,
      origin: originFor(req, currentPort),
      pid: process.pid,
      started_at: STARTED_AT,
      dist_ready: distReady,
    });
    return;
  }

  if (pathname === '/__pp/runtime/port') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { code: 'method_not_allowed', message: '只支持 POST。' });
      return;
    }
    await handlePortChange(req, res);
    return;
  }

  const stateMatch = pathname.match(/^\/__pp\/state\/([a-f0-9]{32})$/);
  if (stateMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { code: 'method_not_allowed', message: '只支持 GET。' });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { code: 'permission_denied', message: '只能在本机读取迁移数据。' });
      return;
    }
    const entry = snapshots.get(stateMatch[1]);
    snapshots.delete(stateMatch[1]);
    if (!entry || entry.expires < Date.now()) {
      sendJson(res, 404, { code: 'not_found', message: '迁移数据不存在或已过期。' });
      return;
    }
    sendJson(res, 200, { ok: true, items: entry.items });
    return;
  }

  if (pathname === '/__pp/update') {
    await handleUpdateCheck(req, res, url);
    return;
  }

  if (pathname === '/__pp/update/apply') {
    // 静态服务没有“把另一份构建换上来”的能力：它按磁盘目录直接读文件。
    sendJson(res, 501, {
      code: 'not_implemented',
      message: '静态服务不支持在线切换版本；请用 Windows 启动器运行站点后再手动更新。',
    });
    return;
  }

  if (pathname.startsWith('/__pp/')) {
    sendJson(res, 404, { code: 'not_found', message: '没有这个运行时接口。' });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, {
      code: 'not_found',
      message: '静态服务不代理 API。请把 /api 交给反向代理或 Go API。',
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { code: 'method_not_allowed', message: '静态服务只支持 GET。' });
    return;
  }

  if (!distReady) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>尚未构建</title>' +
        '<body style="font:16px/1.7 system-ui;padding:48px;max-width:640px">' +
        '<h1 style="font-size:20px">还没有可用的构建产物</h1>' +
        '<p>先运行 <code>npm run build</code>，再执行 <code>npm start</code>。</p></body>',
    );
    return;
  }

  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  let filePath = resolve(DIST, `.${relative}`);
  if (filePath !== DIST && !filePath.startsWith(`${DIST}${sep}`)) {
    sendJson(res, 403, { code: 'forbidden', message: '路径超出了站点目录。' });
    return;
  }

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }

  if (info?.isFile()) {
    await sendFile(req, res, filePath);
    return;
  }

  // 只有导航请求才回退到 index.html，静态资源缺失要如实 404。
  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  if (!extname(pathname) && acceptsHtml && req.method === 'GET') {
    // 内容详情页：先补元数据再返回外壳，抓取器不执行 JS 也能拿到真实分享卡片。
    const contentPath = CONTENT_PATH.exec(pathname);
    if (contentPath) {
      await sendSeoShell(req, res, pathname, contentPath[1], contentPath[2]);
      return;
    }
    await sendFile(req, res, join(DIST, 'index.html'));
    return;
  }

  sendJson(res, 404, { code: 'not_found', message: `没有找到 ${pathname}。` });
}

async function handlePortChange(req, res) {
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { code: 'permission_denied', message: '只能在运行服务的这台电脑上修改端口。' });
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        sendJson(res, 403, { code: 'permission_denied', message: '只接受来自本站页面的修改请求。' });
        return;
      }
    } catch {
      sendJson(res, 403, { code: 'permission_denied', message: '请求来源不合法。' });
      return;
    }
  }

  let body = {};
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    // 只接受 JSON：跨站表单无法构造这种请求，等于多一层 CSRF 防护。
    sendJson(res, 415, { code: 'unsupported_media_type', message: '请求体需要是 application/json。' });
    return;
  }
  try {
    body = JSON.parse((await readBody(req, 6 * 1024 * 1024)) || '{}');
  } catch {
    sendJson(res, 400, { code: 'validation_failed', message: '请求体需要是 JSON。' });
    return;
  }

  const next = normalizePort(body?.port);
  if (!next) {
    sendJson(res, 400, { code: 'validation_failed', message: '端口需要是 1–65535 之间的整数。' });
    return;
  }

  if (next === currentPort) {
    sendJson(res, 200, { ok: true, port: next, previous: currentPort, origin: originFor(req, next), unchanged: true });
    return;
  }

  let servers;
  try {
    servers = await listenAll(next);
  } catch (err) {
    const code = err?.code;
    const message =
      code === 'EADDRINUSE'
        ? `端口 ${next} 已被其他程序占用，换一个端口再试。`
        : code === 'EACCES'
          ? `没有权限监听端口 ${next}。1024 以下的端口需要管理员权限。`
          : `无法监听端口 ${next}：${err?.message || '未知错误'}`;
    sendJson(res, 409, {
      ok: false,
      code: code === 'EADDRINUSE' ? 'port_in_use' : 'listen_failed',
      message,
    });
    return;
  }

  const previous = currentPort;
  const old = activeServers;
  activeServers = servers;
  currentPort = next;

  try {
    await savePort(next);
  } catch {
    /* 端口已经切换成功，写入失败只影响下次启动的默认值 */
  }

  // 把旧地址的浏览器数据交给新地址，避免换端口后又要重新安装。
  let importToken = '';
  const state = body?.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const items = {};
    let total = 0;
    for (const [key, value] of Object.entries(state)) {
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      if (!key.startsWith('pp.') || value.length > 1024 * 1024) continue;
      total += key.length + value.length;
      if (total > SNAPSHOT_LIMIT) {
        total = 0;
        break;
      }
      items[key] = value;
    }
    if (total > 0) {
      const now = Date.now();
      for (const [token, entry] of snapshots) if (entry.expires < now) snapshots.delete(token);
      importToken = randomUUID().replace(/-/g, '');
      snapshots.set(importToken, { items, expires: now + SNAPSHOT_TTL });
    }
  }

  sendJson(res, 200, {
    ok: true,
    port: next,
    previous,
    origin: originFor(req, next),
    import_token: importToken,
  });

  // 等响应落地后再关闭旧端口，避免浏览器拿到半截响应。
  if (old.length) setTimeout(() => old.forEach((server) => server.close(() => undefined)), 400);
}

async function listenOne(port, host) {
  return new Promise((resolveServer, rejectServer) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { code: 'internal', message: '服务器内部错误。' });
        else res.destroy();
      });
    });
    server.once('error', rejectServer);
    server.listen(port, host, () => resolveServer(server));
  });
}

/**
 * 同时监听 IPv4 与 IPv6 回环，`localhost` 不管解析到哪一个都能打开。
 * 某个协议栈不可用时跳过；端口被占用或没权限时整体失败。
 */
async function listenAll(port) {
  const servers = [];
  let lastError = null;
  for (const host of HOSTS) {
    try {
      servers.push(await listenOne(port, host));
    } catch (err) {
      lastError = err;
      if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') {
        servers.forEach((server) => server.close(() => undefined));
        throw err;
      }
    }
  }
  if (!servers.length) throw lastError || new Error('listen failed');
  return servers;
}

function formatOrigin(port, host = 'localhost') {
  return `http://${host}${port === 80 ? '' : `:${port}`}`;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      'Practacu Press 静态站点服务器\n\n' +
        '  npm start                  默认 8080 端口\n' +
        '  npm start -- --port 9090   指定端口\n' +
        '  PP_WEB_PORT=8081 npm start 环境变量指定端口\n' +
        '  PP_WEB_HOST=0.0.0.0        允许局域网访问（默认仅本机）\n',
    );
    return;
  }

  const cliPort = normalizePort(argValue('--port'));
  const envPort = normalizePort(process.env.PP_WEB_PORT);
  const savedPort = await readSavedPort();
  const requested = cliPort || envPort || savedPort || DEFAULT_PORT;

  distReady = await stat(join(DIST, 'index.html'))
    .then((info) => info.isFile())
    .catch(() => false);

  try {
    activeServers = await listenAll(requested);
  } catch (err) {
    const code = err?.code;
    process.stderr.write(
      `\n无法在端口 ${requested} 启动：` +
        (code === 'EADDRINUSE'
          ? '端口已被占用。\n  · 关掉占用它的程序，或运行 npm start -- --port 8081\n'
          : code === 'EACCES'
            ? '没有权限。\n  · 1024 以下的端口需要管理员权限，或改用 npm start -- --port 8081\n'
            : `${err?.message || '未知错误'}\n`) +
        '\n',
    );
    process.exitCode = 1;
    return;
  }

  currentPort = requested;
  if (!cliPort && !envPort && savedPort !== requested) await savePort(requested);

  if (!distReady) {
    process.stdout.write(`\n还没有构建产物：先运行 npm run build（期望目录 ${DIST}）\n`);
  }

  process.stdout.write(
    '\n  Practacu Press\n' +
      `  地址    ${formatOrigin(requested)}\n` +
      `  端口    ${requested}${requested === DEFAULT_PORT ? '（默认，可在后台修改）' : ''}\n` +
      `  产物    ${DIST}\n` +
      '  停止    Ctrl+C\n\n',
  );

  const shutdown = () => {
    const servers = activeServers;
    activeServers = [];
    if (!servers.length) {
      process.exit(0);
      return;
    }
    let left = servers.length;
    for (const server of servers) {
      server.close(() => {
        left -= 1;
        if (left === 0) process.exit(0);
      });
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
