#!/usr/bin/env node
/**
 * E2E 站点的静态服务器 + API 反向代理。
 *
 * 生产部署里 `dist/` 由 Nginx 托管、`/api` 与站点根文件由反向代理转给 Go API；
 * 本文件是同一拓扑的最小实现，让浏览器测试跑在“接近生产”的同源布局上：
 *
 *   - 静态文件来自 web/dist（SPA 回退到 index.html）；
 *   - /api/*、/healthz、/readyz、/sitemap.xml、/robots.txt、/feed* 原样转给 API；
 *   - Set-Cookie 等响应头原样回传（登录、CSRF、刷新 Cookie 都依赖它）；
 *   - WebSocket 升级也转发，避免前端因连不上实时通道而反复重试。
 *
 * 只用于测试；正常开发请用 `npm run dev` 或 `npm start`。
 *
 * 环境变量：
 *   PP_E2E_WEB_PORT    监听端口，默认 18100
 *   PP_E2E_API_ORIGIN  API 源，默认 http://127.0.0.1:18080
 *   PP_E2E_DIST        静态目录，默认 web/dist
 */
import http from 'node:http';
import net from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(process.env.PP_E2E_DIST || join(WEB_DIR, 'dist'));
const API = new URL(process.env.PP_E2E_API_ORIGIN || 'http://127.0.0.1:18080');
const PORT = Number(process.env.PP_E2E_WEB_PORT || 18100);
const HOST = process.env.PP_E2E_WEB_HOST || '127.0.0.1';

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

/** 这些路径属于 API 或站点根文件，必须交给 Go 服务，不能回退到 SPA。 */
function isProxied(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/healthz' ||
    pathname === '/readyz' ||
    pathname === '/sitemap.xml' ||
    pathname === '/robots.txt' ||
    pathname === '/feed.xml' ||
    pathname.startsWith('/feed/')
  );
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function proxy(req, res) {
  // 保留浏览器的 Host：站点解析、sitemap 与 robots 里的绝对地址都按它生成，
  // 这和 Vite 开发代理 (changeOrigin: false) 以及生产反代的行为一致。
  const headers = { ...req.headers };
  delete headers['accept-encoding'];
  const upstream = http.request(
    {
      protocol: API.protocol,
      hostname: API.hostname,
      port: API.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (response) => {
      const responseHeaders = {};
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        const value = response.rawHeaders[index + 1];
        if (responseHeaders[name] === undefined) responseHeaders[name] = value;
        else if (Array.isArray(responseHeaders[name])) responseHeaders[name].push(value);
        else responseHeaders[name] = [responseHeaders[name], value];
      }
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'bad_gateway', message: `E2E proxy: ${error.message}` }));
  });
  req.pipe(upstream);
}

async function sendFile(res, filePath, status = 200) {
  const info = await stat(filePath);
  res.writeHead(status, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(filePath).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (isProxied(url.pathname)) {
    proxy(req, res);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  // 静态资源：只允许 dist 目录内的真实文件。
  if (pathname !== '/') {
    const candidate = resolve(join(DIST, pathname));
    if (candidate !== DIST && !candidate.startsWith(DIST + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        await sendFile(res, candidate);
        return;
      }
    } catch {
      /* 文件不存在：落到 SPA 回退 */
    }
    // 带扩展名的请求是资源，返回 404 比返回 HTML 更容易定位问题。
    if (extname(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
  }

  try {
    await sendFile(res, join(DIST, 'index.html'));
  } catch {
    res
      .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(`E2E web root not built: ${DIST}`);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error?.stack || error));
  });
});

// 浏览器会申请 `/api/v1/ws`；直接按原始请求行转发升级头即可。
server.on('upgrade', (req, socket, head) => {
  if (!isProxied(new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(Number(API.port), API.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e-web] serving ${DIST} on http://${HOST}:${PORT}`);
  console.log(`[e2e-web] proxying /api, /healthz, /readyz, /sitemap.xml, /robots.txt -> ${API.origin}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
