#!/usr/bin/env node
/**
 * Practacu Press 静态站点服务器。
 *
 * - 默认监听 8080 端口（启动器与生产打包也用这个默认值）；
 * - 端口可以在管理后台「站点设置 → 访问端口」里热切换，不需要重启进程；
 * - 选定的端口写入 apps/web/.runtime/web.json，下次启动沿用。
 *
 * 用法：
 *   npm start                  # 默认 8080
 *   npm start -- --port 9090   # 临时换一个端口
 *   PP_WEB_PORT=8081 npm start # 也可以用环境变量
 *
 * 只做静态文件与运行时端口接口；/api、/healthz、/readyz 仍然交给反向代理或 Go API，
 * 这里会明确返回 JSON 404，避免 SPA 的 HTML 回退被误判成后端可用。
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

  if (pathname.startsWith('/__pp/')) {
    sendJson(res, 404, { code: 'not_found', message: '没有这个运行时接口。' });
    return;
  }

  if (pathname === '/healthz' || pathname === '/readyz' || pathname.startsWith('/api/')) {
    sendJson(res, 404, {
      code: 'not_found',
      message: '静态服务不代理 API。请把 /api、/healthz、/readyz 交给反向代理或 Go API。',
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
