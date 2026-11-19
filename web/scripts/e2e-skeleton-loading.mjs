#!/usr/bin/env node
/**
 * 原位骨架加载（SKELETON / SHIMMER）端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 覆盖：
 * 1. 演示模式 + 预置配置：启用加载并选 `skeleton-shimmer`，首页出现原位骨架，
 *    没有全屏遮罩，`<html data-pp-skeleton="both">`；
 * 2. 数据到达后骨架消失、真实区块出现（原地替换）；
 * 3. 三种预设分别写 pulse / sweep / both；
 * 4. 性能设置关闭动画时 `data-motion="reduced"`，骨架动画为 none；
 * 5. 后台「加载动画」页：预设分组、选中骨架预设后预览区出现 data-pp-skeleton，
 *    切回全屏预设后恢复 LoadingScene。
 *
 * 前置：
 *   cd web
 *   npm run build
 *   node scripts/serve.mjs --port 8099
 *
 * 运行：
 *   cd web
 *   node scripts/e2e-skeleton-loading.mjs
 *
 * 环境变量：
 *   CHROME_PATH    Chrome / Edge 可执行文件（默认自动探测常见安装路径）
 *   PP_E2E_BASE    站点地址（默认 http://127.0.0.1:8099）
 *   PP_E2E_PORT    CDP 调试端口（默认 9364）
 *   PP_E2E_SHOTS   截图目录（默认 web/.tmp/shots-skeleton/；设 0 关闭截图）
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

const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const PORT = Number(process.env.PP_E2E_PORT ?? 9364);
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHOTS_RAW = (process.env.PP_E2E_SHOTS ?? '').trim();
const SHOTS_ENABLED = SHOTS_RAW !== '0';
const SHOTS_DIR = !SHOTS_ENABLED
  ? path.join(TMP, 'shots-skeleton')
  : SHOTS_RAW
    ? path.isAbsolute(SHOTS_RAW)
      ? SHOTS_RAW
      : path.resolve(WEB_ROOT, SHOTS_RAW)
    : path.join(TMP, 'shots-skeleton');
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-profile-skeleton-${process.pid}/`, import.meta.url));

const CONFIG_KEY = 'pp.web.config.v1';
const ADMIN = { email: 'admin@practacu.local', password: 'practacu' };
const DEMO_SITE_ID = 'site_main';

const CONFIG = (preset, reduced = false) => ({
  version: 1,
  setup_complete: true,
  mode: 'demo',
  api_base: 'http://127.0.0.1:8080',
  site_id: DEMO_SITE_ID,
  database: 'sqlite',
  created_at: '2026-11-02T00:00:00.000Z',
  docs_url: '/docs',
  performance: { disable_animations: reduced },
  loading: {
    enabled: true,
    preset,
    text: '正在载入',
    accent_mode: 'theme',
    accent: '#1f5c4a',
    background_mode: 'theme',
    background: '#ffffff',
    size: 44,
    min_duration_ms: 450,
    show_on_first_load: true,
    show_on_navigation: false,
    custom_css: '',
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ws;
let chromeProc;
let msgId = 0;
const pending = new Map();
const results = [];

function assertChrome() {
  if (CHROME) return;
  throw new Error('没找到 Chrome/Edge。请设置 CHROME_PATH。');
}

async function startChrome() {
  assertChrome();
  chromeProc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,1000',
      BASE,
    ],
    { stdio: 'ignore' },
  );
  await waitDevtools();
}

async function waitDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) return res.json();
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`devtools 未就绪（端口 ${PORT}）`);
}

async function connectPage() {
  const targets = await waitDevtools();
  const page = targets.find((target) => target.type === 'page') ?? targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('找不到可调试的页面目标');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaljs(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知异常';
    throw new Error(`页面脚本异常: ${String(description).slice(0, 400)}`);
  }
  return result.result?.value;
}

const q = (value) => JSON.stringify(value);
const sleepEval = (ms) => evaljs(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);

async function waitUntil(expression, timeout = 12000, interval = 120) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await evaljs(expression);
      if (value) return value;
    } catch {
      /* 页面可能正在导航 */
    }
    await sleep(interval);
  }
  return null;
}

async function shot(name) {
  if (!SHOTS_ENABLED) return;
  try {
    await mkdir(SHOTS_DIR, { recursive: true });
    const result = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log(`  截图: ${path.join(SHOTS_DIR, `${name}.png`)}`);
  } catch (err) {
    console.warn(`  截图失败（${name}）: ${err.message}`);
  }
}

function check(section, name, ok, extra = '') {
  results.push({ section, name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${section}] ${name}${extra ? ` | ${extra}` : ''}`);
}

/** 每次导航前注入：首次访问写入演示配置；把 demo 请求的短等待拉长，方便截图。 */
async function installSeedScript() {
  const seed = `
    (() => {
      try {
        if (!localStorage.getItem(${q(CONFIG_KEY)})) {
          localStorage.setItem(${q(CONFIG_KEY)}, JSON.stringify(${q(CONFIG('skeleton-shimmer'))}));
        }
      } catch (err) { console.warn('seed config failed', err); }
      const original = window.setTimeout;
      window.setTimeout = function (fn, ms, ...args) {
        return original.call(window, fn, typeof ms === 'number' && ms > 0 && ms < 400 ? ms * 12 : ms, ...args);
      };
    })();`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
}

async function goto(pathname, wait = 900) {
  await send('Page.navigate', { url: BASE + pathname });
  await waitUntil(`document.readyState === 'complete'`, 15000);
  await sleep(wait);
}

async function setPreset(preset, reduced = false) {
  await evaljs(`localStorage.setItem(${q(CONFIG_KEY)}, ${q(JSON.stringify(CONFIG(preset, reduced)))}); true`);
  await goto('/', 900);
  await waitUntil(`document.documentElement.dataset.ppSkeleton === ${q(
    preset === 'skeleton' ? 'pulse' : preset === 'shimmer' ? 'sweep' : 'both',
  )}`, 8000);
}

async function loginAsAdmin() {
  await goto('/login', 700);
  await evaljs(`(() => {
    const set = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) return false;
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    return set(${q('#auth-email')}, ${q(ADMIN.email)}) && set(${q('#auth-password')}, ${q(ADMIN.password)});
  })()`);
  await evaljs(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.type === 'submit' && /登录|Sign in/.test(node.textContent ?? ''),
    );
    if (button) button.click();
    return !!button;
  })()`);
  return await waitUntil(`location.pathname !== '/login'`, 10000);
}

async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  await startChrome();
  await connectPage();
  await installSeedScript();

  console.log('\n=== A. 首页原位骨架（skeleton-shimmer） ===');
  await goto('/', 700);
  const state = await waitUntil(`(() => {
    const html = document.documentElement;
    const skeletons = document.querySelectorAll('.pp-skel-line, .skeleton span').length;
    return {
      motion: html.dataset.ppSkeleton ?? '',
      skeletons,
      overlay: !!document.querySelector('.pp-loading-overlay'),
      blocks: document.querySelectorAll('section[data-pp-block]').length,
    };
  })()`, 8000);
  check('SKELETON', '首页出现原位骨架且没有全屏遮罩', state && state.skeletons > 0 && !state.overlay,
    state ? `motion=${state.motion} skeletons=${state.skeletons} overlay=${state.overlay}` : '读不到状态');
  check('SKELETON', 'html data-pp-skeleton=both', state?.motion === 'both', state?.motion ?? '');
  await shot('01-home-skeleton-both');

  const lightSkel = await evaljs(`(() => {
    const line = document.querySelector('.pp-skel-line');
    return line ? getComputedStyle(line).backgroundColor : '';
  })()`);
  const toggled = await evaljs(`(() => {
    const button = document.querySelector('.mode-toggle');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(700);
  const darkSkel = await evaljs(`(() => {
    const line = document.querySelector('.pp-skel-line');
    return {
      color: line ? getComputedStyle(line).backgroundColor : '',
      mode: document.documentElement.dataset.mode ?? '',
    };
  })()`);
  check('THEME', '站内切换深色后骨架颜色跟随主题令牌', toggled && darkSkel && darkSkel.mode === 'dark' && lightSkel !== darkSkel.color,
    `light=${lightSkel} dark=${darkSkel?.color} mode=${darkSkel?.mode}`);
  await shot('09-home-skeleton-dark');

  console.log('\n=== B. 数据到达后原地替换 ===');
  await sleep(3200);
  const loaded = await evaljs(`(() => ({
    skeletons: document.querySelectorAll('.pp-skel-line, .skeleton span').length,
    blocks: document.querySelectorAll('section[data-pp-block]').length,
    text: (document.body.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  }))()`);
  check('SKELETON', '数据到达后骨架消失、真实区块出现', loaded.skeletons === 0 && loaded.blocks > 0,
    `skeletons=${loaded.skeletons} blocks=${loaded.blocks} text=${loaded.text}`);
  await shot('02-home-loaded');

  console.log('\n=== C. 三种预设动效 ===');
  await setPreset('skeleton');
  const pulse = await evaljs(`document.documentElement.dataset.ppSkeleton`);
  check('MOTION', 'skeleton → pulse', pulse === 'pulse', String(pulse));
  await shot('03-home-skeleton-pulse');

  await setPreset('shimmer');
  const sweep = await evaljs(`document.documentElement.dataset.ppSkeleton`);
  check('MOTION', 'shimmer → sweep', sweep === 'sweep', String(sweep));
  await shot('04-home-skeleton-sweep');

  console.log('\n=== D. 减少动效 ===');
  await setPreset('skeleton-shimmer', true);
  const reduced = await evaljs(`(() => {
    const line = document.querySelector('.pp-skel-line');
    return {
      motion: document.documentElement.dataset.ppSkeleton,
      anim: line ? getComputedStyle(line).animationName : 'none',
    };
  })()`);
  check('MOTION', 'reduced 时占位动画停止', reduced && reduced.anim === 'none',
    reduced ? `motion=${reduced.motion} animation=${reduced.anim}` : '读不到');
  await shot('05-home-skeleton-reduced');

  console.log('\n=== F. 全屏预设回归 ===');
  const overlayConfig = {
    ...CONFIG('spinner'),
    loading: { ...CONFIG('spinner').loading, min_duration_ms: 3000 },
  };
  await evaljs(`localStorage.setItem(${q(CONFIG_KEY)}, ${q(JSON.stringify(overlayConfig))}); true`);
  await goto('/', 500);
  const overlayShown = await waitUntil(`!!document.querySelector('.pp-loading-overlay .pp-loading-spinner')`, 6000);
  const overlayState = await evaljs(`(() => ({
    overlay: !!document.querySelector('.pp-loading-overlay'),
    skeleton: !!document.documentElement.dataset.ppSkeleton,
    blocks: document.querySelectorAll('.pp-skel-feed, .pp-skel-list, .pp-skel-grid, .pp-skel-panel').length,
  }))()`);
  check('OVERLAY', '全屏预设仍显示遮罩且不进入骨架模式', !!overlayShown && overlayState?.overlay && !overlayState.skeleton && overlayState.blocks === 0,
    overlayState ? `overlay=${overlayState.overlay} skeleton=${overlayState.skeleton} skeletonBlocks=${overlayState.blocks}` : '读不到');
  await shot('10-home-overlay-spinner');
  await sleep(3600);
  const overlayGone = await evaljs(`!document.querySelector('.pp-loading-overlay')`);
  check('OVERLAY', '最短展示时长结束后遮罩消失', overlayGone, String(overlayGone));

  console.log('\n=== E. 后台加载设置页 ===');
  await evaljs(`localStorage.setItem(${q(CONFIG_KEY)}, ${q(JSON.stringify(CONFIG('skeleton-shimmer', false)))}); true`);
  await goto('/login', 500);
  const loggedIn = await loginAsAdmin();
  check('ADMIN', '演示管理员登录成功', !!loggedIn, loggedIn || '仍停留在 /login');
  if (!loggedIn) throw new Error('登录失败，无法验收后台加载设置页');

  await goto('/admin/loading', 900);
  const ready = await waitUntil(`document.querySelectorAll('.loading-preset-card').length >= 8`, 12000);
  check('ADMIN', '加载设置页打开', !!ready, ready ? '' : '预设卡没有出现');

  const page = await evaljs(`(() => {
    const labels = [...document.querySelectorAll('.field-label')].map((n) => (n.textContent ?? '').trim());
    const groups = labels.filter((label) => label === '全屏加载' || label === '页面骨架');
    const cards = document.querySelectorAll('.loading-preset-card').length;
    const fullPreviewButtons = [...document.querySelectorAll('button')].filter(
      (node) => (node.textContent ?? '').trim() === '全屏预览',
    ).length;
    return { groups, cards, fullPreviewButtons };
  })()`);
  check('ADMIN', '预设分为「全屏加载 / 页面骨架」两组', page && page.cards >= 8 && page.groups.length === 2,
    page ? `cards=${page.cards} groups=[${page.groups.join(', ')}]` : '读不到页面');

  const pickOverlay = await evaljs(`(() => {
    const card = [...document.querySelectorAll('.loading-preset-card')].find((node) =>
      (node.textContent ?? '').includes('圆环'),
    );
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await waitUntil(`!!document.querySelector('.loading-preview-stage .pp-loading-scene')`, 8000);
  const overlayPreview = await evaljs(`(() => ({
    scene: !!document.querySelector('.loading-preview-stage .pp-loading-scene'),
    skeletonStage: !!document.querySelector('.loading-preview-stage [data-pp-skeleton]'),
    fullPreviewButtons: [...document.querySelectorAll('button')].filter(
      (node) => (node.textContent ?? '').trim() === '全屏预览',
    ).length,
  }))()`);
  check('ADMIN', '全屏预设仍显示全屏预览与全屏预览按钮', pickOverlay && overlayPreview?.scene && !overlayPreview.skeletonStage && overlayPreview.fullPreviewButtons > 0,
    overlayPreview ? `scene=${overlayPreview.scene} skeleton=${overlayPreview.skeletonStage} buttons=${overlayPreview.fullPreviewButtons}` : '读不到');
  await shot('06-admin-loading-overlay-presets');

  const clicked = await evaljs(`(() => {
    const card = [...document.querySelectorAll('.loading-preset-card')].find((node) =>
      (node.textContent ?? '').includes('骨架 + 扫光'),
    );
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await waitUntil(`!!document.querySelector('.loading-skeleton-preview')`, 8000);
  const skeletonPreview = await evaljs(`(() => {
    const stage = document.querySelector('[data-pp-skeleton]');
    const preview = document.querySelector('.loading-skeleton-preview');
    return {
      picked: !!document.querySelector('.loading-preset-card.is-selected'),
      stage: stage ? stage.getAttribute('data-pp-skeleton') : '',
      preview: !!preview,
      lines: document.querySelectorAll('.loading-skeleton-preview .pp-skel-line, .loading-skeleton-preview .pp-skel-media').length,
      fullPreviewButtons: [...document.querySelectorAll('button')].filter(
        (node) => (node.textContent ?? '').trim() === '全屏预览',
      ).length,
    };
  })()`);
  check('ADMIN', '选中骨架预设后出现迷你页面骨架预览且隐藏全屏预览', clicked && skeletonPreview?.preview && skeletonPreview.lines > 0 && skeletonPreview.fullPreviewButtons === 0,
    skeletonPreview ? `stage=${skeletonPreview.stage} lines=${skeletonPreview.lines} buttons=${skeletonPreview.fullPreviewButtons}` : '读不到');
  await shot('07-admin-loading-skeleton-preview');

  const backToOverlay = await evaljs(`(() => {
    const card = [...document.querySelectorAll('.loading-preset-card')].find((node) =>
      (node.textContent ?? '').includes('圆环'),
    );
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await waitUntil(`!!document.querySelector('.loading-preview-stage .pp-loading-scene')`, 8000);
  const overlayAgain = await evaljs(`(() => ({
    scene: !!document.querySelector('.loading-preview-stage .pp-loading-scene'),
    skeletonStage: !!document.querySelector('.loading-preview-stage [data-pp-skeleton]'),
  }))()`);
  check('ADMIN', '切回全屏预设后恢复全屏预览', backToOverlay && overlayAgain?.scene && !overlayAgain.skeletonStage,
    overlayAgain ? `scene=${overlayAgain.scene} skeleton=${overlayAgain.skeletonStage}` : '读不到');
  await shot('08-admin-loading-overlay-preview');

  const failed = results.filter((item) => !item.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    for (const item of failed) console.log(`FAIL ${item.section} · ${item.name}${item.extra ? ` | ${item.extra}` : ''}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`\n运行失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      chromeProc?.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
  });
