/**
 * 主题明暗模式对比度审计（临时脚本，零依赖，CDP 驱动无头 Chrome）。
 *
 * 用法（先 npm run build + node scripts/serve.mjs；或直接对 npm run dev 的 5173 跑）：
 *   $env:PP_AUDIT_THEME='paper-dark'   # 纸白 + 深色
 *   $env:PP_AUDIT_THEME='night-dark'   # 夜航 + 深色（bento）
 *   $env:PP_AUDIT_THEME='paper-light'  # 纸白 + 浅色（回归）
 *   cd apps/web
 *   node scripts/audit-contrast.mjs
 *
 * 环境变量：PP_AUDIT_THEME / PP_E2E_BASE / PP_E2E_PORT / CHROME_PATH
 *
 * 输出：apps/web/.tmp/dark-audit-<theme>.json、apps/web/.tmp/shots-dark-<theme>/、终端摘要。
 * 判定阈值：对比度 < 3.2 记一条；后台固定纸白，本身较低的 faint 提示属既有设计，
 * 报告里按 admin 页面单独统计，站点前台（home / article / messages / login 等）应为 0。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:80').replace(/\/+$/, '');
const THEME = process.env.PP_AUDIT_THEME ?? 'paper-dark';
const PORT = Number(process.env.PP_E2E_PORT ?? (THEME === 'night-dark' ? 9341 : THEME === 'paper-light' ? 9342 : 9340));
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS = path.join(TMP, `shots-dark-${THEME}`);
await mkdir(SHOTS, { recursive: true });
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-dark-audit-${THEME}-${process.pid}/`, import.meta.url));

const themeSettings =
  THEME === 'night-dark'
    ? { preset: 'night', mode: 'dark' }
    : THEME === 'paper-light'
      ? { preset: 'paper', mode: 'light' }
      : { preset: 'paper', mode: 'dark' };
const variant = THEME === 'night-dark' ? 'bento' : 'classic';

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,900',
    BASE,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) return res.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools 未就绪');
}

const targets = await waitDevtools();
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('WebSocket 连接失败'));
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id != null && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaljs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    throw new Error(`页面脚本异常: ${String(d).slice(0, 400)}`);
  }
  return r.result.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1200);
}
async function waitUntil(expression, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaljs(expression)) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}

const CONFIG = {
  version: 1,
  setup_complete: true,
  mode: 'demo',
  api_base: '',
  site_id: 'demo-site',
  database: 'sqlite',
  created_at: new Date().toISOString(),
  docs_url: '/admin/docs',
  site_kind: 'community',
  customization: {
    theme: themeSettings,
    active_theme: THEME === 'night-dark' ? 'night' : 'default',
    layout: {
      variant,
      announcement: '夜间模式公告条：这段文字应该清晰可读。',
      announcement_link: '',
    },
    extensions: { reading_progress: true, toc: true, code_copy: true, share: true, announcement: true, back_to_top: true },
  },
};

/* 页面内：对比度审计。 */
const AUDIT_FN = `(() => {
  const results = [];
  const parse = (value) => {
    if (!value) return null;
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const composite = (fg, bg) => {
    const a = fg.a ?? 1;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  };
  const effectiveBg = (el) => {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      // 渐变 / 背景图上的文字无法用纯色算法判断对比度，交给人工或截图检查。
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.01) layers.push(c);
      if (c && c.a >= 0.99) break;
      node = node.parentElement;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const htmlBg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (htmlBg && htmlBg.a > 0.99) bg = htmlBg;
    for (let i = layers.length - 1; i >= 0; i--) bg = composite(layers[i], bg);
    return bg;
  };
  const selectorOf = (el) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let s = node.tagName.toLowerCase();
      if (node.id) { s += '#' + node.id; parts.unshift(s); break; }
      const cls = [...node.classList].slice(0, 3).join('.');
      if (cls) s += '.' + cls;
      parts.unshift(s);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };
  const root = document.body;
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('script,style,svg,iframe,canvas,textarea,option')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.bottom < -40 || rect.top > window.innerHeight + 40) continue;
    const directText = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!directText.length) continue;
    const text = directText.map((n) => n.textContent.trim()).join(' ').slice(0, 60);
    const color = parse(cs.color);
    if (!color) continue;
    const bg = effectiveBg(el);
    if (!bg) continue;
    const fg = composite(color, bg);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 3.2) {
      results.push({
        selector: selectorOf(el),
        text,
        ratio: Math.round(ratio * 100) / 100,
        color: 'rgb(' + Math.round(fg.r) + ',' + Math.round(fg.g) + ',' + Math.round(fg.b) + ')',
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        fontSize: cs.fontSize,
        mode: document.documentElement.dataset.mode || '',
      });
    }
  }
  const seen = new Set();
  return results.filter((r) => {
    const key = r.selector + '|' + r.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 300);
})()`;

async function auditPage(name) {
  await sleep(500);
  const failures = await evaljs(AUDIT_FN);
  await shot(name);
  return failures.map((item) => ({ page: name, ...item }));
}

async function login() {
  await goto(BASE + '/login');
  await sleep(900);
  const hasForm = await evaljs(`!!document.querySelector('input[type="email"]')`);
  if (!hasForm) return true;
  await evaljs(`(() => {
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(document.querySelector('input[type="email"]'), 'admin@practacu.local');
    set(document.querySelector('input[type="password"]'), 'practacu');
    return true;
  })()`);
  await evaljs(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.type === 'submit' && /登录/.test(node.textContent ?? ''));
    if (button) { button.click(); return true; }
    document.querySelector('form')?.requestSubmit();
    return true;
  })()`);
  const ok = await waitUntil(`location.pathname !== '/login' || !!document.querySelector('.header-user')`, 12000);
  await sleep(600);
  return ok;
}

async function logout() {
  const opened = await evaljs(`(() => {
    const trigger = document.querySelector('.user-trigger');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  if (!opened) return false;
  await sleep(300);
  const clicked = await evaljs(`(() => {
    const item = [...document.querySelectorAll('.menu-pop .menu-item')].find((node) => /退出登录/.test(node.textContent ?? ''));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!clicked) return false;
  await waitUntil(`!document.querySelector('.user-trigger')`, 8000);
  await sleep(500);
  return true;
}

const all = [];
try {
  await send('Page.enable');
  await send('Runtime.enable');

  await goto(BASE + '/');
  await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(CONFIG))}); true`);
  await goto(BASE + '/');
  await sleep(1400);
  await login();
  await goto(BASE + '/');
  await sleep(900);
  const appliedMode = await evaljs(`document.documentElement.dataset.mode`);
  all.push(...(await auditPage('home')));

  // 实时切换明暗：不刷新页面，验证组件跟着令牌变化。
  const toggled = await evaljs(`(() => {
    const button = document.querySelector('.mode-toggle');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (toggled) {
    await sleep(600);
    const toggledMode = await evaljs(`document.documentElement.dataset.mode`);
    const failures = await auditPage('home-toggled');
    for (const item of failures) item.toggledTo = toggledMode;
    all.push(...failures);
    await evaljs(`(() => { const b = document.querySelector('.mode-toggle'); if (b) b.click(); return true; })()`);
    await sleep(400);
  }

  // 用户菜单。
  const opened = await evaljs(`(() => { const t = document.querySelector('.user-trigger'); if (t) { t.click(); return true; } return false; })()`);
  if (opened) {
    await sleep(400);
    all.push(...(await auditPage('home-usermenu')));
    await evaljs(`document.body.click(); true`);
    await sleep(200);
  }

  // 头部搜索浮层（输入关键字触发结果）。
  const searchOpen = await evaljs(`(() => {
    const input = document.querySelector('.site-search input');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '评论');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (searchOpen) {
    await sleep(900);
    all.push(...(await auditPage('home-search')));
    await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(200);
  }

  // 命令面板（Shift+K）。
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', shiftKey: true, bubbles: true })); true`);
  await sleep(500);
  all.push(...(await auditPage('home-command')));
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(200);

  // 列表 / 文章 / 作者主页 / 搜索页。
  await goto(BASE + '/articles');
  await sleep(1100);
  all.push(...(await auditPage('list')));
  const href = await evaljs(`(() => { const a = document.querySelector('a[href^="/a/"]'); return a ? a.getAttribute('href') : ''; })()`);
  if (href) {
    await goto(BASE + href);
    await sleep(1400);
    all.push(...(await auditPage('article')));
    await evaljs(`window.scrollTo(0, document.body.scrollHeight * 0.7); true`);
    await sleep(700);
    all.push(...(await auditPage('article-bottom')));
    const authorHref = await evaljs(`(() => { const a = document.querySelector('.author-card a[href^="/u/"]'); return a ? a.getAttribute('href') : ''; })()`);
    if (authorHref) {
      await goto(BASE + authorHref);
      await sleep(1100);
      all.push(...(await auditPage('profile')));
    }
  }
  await goto(BASE + '/search?q=' + encodeURIComponent('评论'));
  await sleep(1100);
  all.push(...(await auditPage('search')));

  // 通知 / 私信。
  await goto(BASE + '/notifications');
  await sleep(1000);
  all.push(...(await auditPage('notifications')));
  await goto(BASE + '/messages');
  await sleep(1000);
  all.push(...(await auditPage('messages')));

  // 未登录的认证页。
  if (await logout()) {
    await goto(BASE + '/login');
    await sleep(900);
    all.push(...(await auditPage('login-page')));
    await goto(BASE + '/register');
    await sleep(900);
    all.push(...(await auditPage('register-page')));
    await login();
  }

  // 后台（固定纸白）：编辑器 + 链接弹窗 + 扩展页 + 主题设置 + 站点设置。
  await goto(BASE + '/admin/content/new/article');
  await sleep(1300);
  all.push(...(await auditPage('admin-editor')));
  const dialog = await evaljs(`(() => {
    const button = [...document.querySelectorAll('.rich-toolbar button')].find((node) => /链接/.test(node.title || node.getAttribute('aria-label') || ''));
    if (button) { button.click(); return true; }
    return false;
  })()`);
  if (dialog) {
    await sleep(600);
    all.push(...(await auditPage('admin-editor-link-dialog')));
  }
  await goto(BASE + '/admin/extensions');
  await sleep(1300);
  all.push(...(await auditPage('admin-extensions')));
  await goto(BASE + '/admin/themes');
  await sleep(1300);
  all.push(...(await auditPage('admin-themes')));
  await goto(BASE + '/admin/settings');
  await sleep(1300);
  all.push(...(await auditPage('admin-settings')));

  const reportPath = path.join(TMP, `dark-audit-${THEME}.json`);
  await writeFile(reportPath, JSON.stringify({ theme: THEME, appliedMode, base: BASE, total: all.length, failures: all }, null, 2));
  console.log(`\n[${THEME}] 审计完成：${all.length} 个低对比度文本节点 → ${reportPath}`);
  const byPage = {};
  for (const item of all) (byPage[item.page] ??= []).push(item);
  for (const [pageName, items] of Object.entries(byPage)) {
    console.log(`\n== ${pageName} (${items.length}) ==`);
    for (const item of items.slice(0, 10)) {
      console.log(`  ${item.ratio}  ${item.color} on ${item.bg}  ${item.selector}  「${item.text}」`);
    }
    if (items.length > 10) console.log(`  ... 另外 ${items.length - 10} 条见报告`);
  }
} catch (err) {
  console.error('审计失败：', err);
  process.exitCode = 1;
} finally {
  try {
    ws.close();
  } catch {}
  proc.kill();
}
