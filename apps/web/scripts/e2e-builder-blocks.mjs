#!/usr/bin/env node
/**
 * 页面编排「按钮 / 通用外观 / 组件库回归」端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 本轮改动：思维导图已从页面编排迁到文章写作（见
 * docs/superpowers/plans/2026-11-01-article-diagrams-plan.md），所以本脚本删掉了
 * 原先的思维导图区块步骤，改为一条负向断言：组件库里不能再出现「思维导图」。
 * 文章图表的验收见 scripts/e2e-article-diagrams.mjs。
 *
 * 覆盖：
 * 1. 全新安装：走完七步安装向导并选择「演示数据」，登录演示管理员；
 * 2. 打开 `/admin/theme`（全屏页面编排工作台），等待左侧组件库 `.builder-palette`；
 * 3. 组件库点「按钮」→ 右侧属性面板点两次「添加按钮」并填文字 / 链接（按钮区块的
 *    默认值现在是空列表 `buttons: []`，所以预览里先没有 `.pp-action-btn`），
 *    真实前台预览 iframe（同源，可直接读 contentDocument）随即出现两个
 *    `section[data-pp-block][data-block-type="button"] .pp-action-btn`；
 * 4. 负向断言：组件库 `.palette-item` 的文案里没有「思维导图」；
 * 5. 左侧结构树选中按钮区块，改外观：圆角 lg / 阴影 md / 裁剪 16:9 / 内边距 16 /
 *    背景 #eef3ef（逐项派发 input + change 事件）；
 * 6. 轮询读 iframe 里按钮区块的 getComputedStyle：borderRadius 16px、boxShadow 非
 *    none、overflow hidden、aspectRatio 含 16/9、padding 16px、背景 rgb(238,243,239)；
 * 7. 断言 localStorage `pp.web.config.v1.customization.home.blocks` 里存在
 *    type=button，且按钮的 appearance 与两个按钮条目都已落盘；刷新后重新打开
 *    `/admin/theme` 断言仍在（配置与预览渲染都还在）；
 * 8. 截图存 `.tmp/shots-builder/`，打印 PASS/FAIL 汇总，失败时退出码非 0。
 *
 * 前置：
 *   cd apps/web
 *   npm run build
 *   node scripts/serve.mjs --port 8099
 *
 * 运行：
 *   cd apps/web
 *   node scripts/e2e-builder-blocks.mjs
 *   # PowerShell 显式指定站点与 CDP 端口：
 *   $env:PP_E2E_BASE='http://127.0.0.1:8099'; $env:PP_E2E_PORT='9336'; node scripts/e2e-builder-blocks.mjs
 *
 * 环境变量：
 *   CHROME_PATH    Chrome / Edge 可执行文件（默认自动探测常见安装路径）
 *   PP_E2E_BASE    站点地址（默认 http://127.0.0.1:8099）
 *   PP_E2E_PORT    CDP 调试端口（默认 9362；与其它 e2e 脚本的 9333/9334/9350/9360 错开）
 *   PP_E2E_SHOTS   截图目录（默认 apps/web/.tmp/shots-builder/；设 0 关闭截图）
 *
 * 选择器策略与 e2e-features.mjs 一致：某个断言失败时会打印当前路径、可见文案、
 * 组件库/结构树/预览 iframe 的实际 DOM 概要，方便区分「功能缺陷 / 选择器过期 /
 * 环境问题」。本脚本不修改任何业务源码。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const PORT = Number(process.env.PP_E2E_PORT ?? 9362);

const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHOTS_RAW = (process.env.PP_E2E_SHOTS ?? '').trim();
const SHOTS_ENABLED = SHOTS_RAW !== '0';
const SHOTS_DIR = !SHOTS_ENABLED
  ? path.join(TMP, 'shots-builder')
  : SHOTS_RAW
    ? path.isAbsolute(SHOTS_RAW)
      ? SHOTS_RAW
      : path.resolve(WEB_ROOT, SHOTS_RAW)
    : path.join(TMP, 'shots-builder');
// pid 后缀让每次运行都从干净 profile 开始；不做递归删除，避免沙箱拦截。
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-profile-builder-${process.pid}/`, import.meta.url));

const ADMIN = { name: 'QA 验证员', email: 'admin@practacu.local', password: 'practacu' };
const CONFIG_KEY = 'pp.web.config.v1';

/** 本次验收写入的外观值（面板 id → 值）。 */
const APPEARANCE = {
  radius: 'lg',
  shadow: 'md',
  crop: '16:9',
  padding: '16',
  background: '#eef3ef',
};

/** 期望的计算样式（iframe 内按钮区块）。 */
const EXPECT = {
  borderRadius: '16px',
  padding: '16px',
  aspectRatio: '16/9',
  backgroundColor: 'rgb(238, 243, 239)',
};

/* 选择器候选集中在这里，实现调整时只改这一处。 */
const SEL = {
  wizard: '.wiz',
  palette: '.builder-palette',
  paletteGroup: '.builder-palette details.palette-group',
  paletteItem: '.builder-palette .palette-item',
  treeRow: '.tree-row',
  previewFrame: '.builder-preview iframe',
  buttonSection: 'section[data-pp-block][data-block-type="button"]',
  appearance: {
    radius: '#appearance-radius',
    shadow: '#appearance-shadow',
    crop: '#appearance-crop',
    padding: '#appearance-padding',
    background: '#appearance-bg',
  },
};

/* ------------------------------------------------------------------ */
/* 记录与输出                                                          */
/* ------------------------------------------------------------------ */

const results = [];
const shots = [];
let currentSection = 'SETUP';

function logLine(line) {
  console.log(line);
}

function pass(section, name, extra = '') {
  results.push({ section, name, ok: true, extra });
  logLine(`  PASS [${section}] ${name}${extra ? '  · ' + extra : ''}`);
}

function fail(section, name, extra = '') {
  results.push({ section, name, ok: false, extra });
  logLine(`  FAIL [${section}] ${name}${extra ? '  · ' + extra : ''}`);
}

/* ------------------------------------------------------------------ */
/* CDP 基础                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertChrome() {
  if (CHROME) return;
  throw new Error(
    `没找到 Chrome/Edge。请设置 CHROME_PATH，例如：$env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`,
  );
}

let ws;
let chromeProc;
let msgId = 0;
const pending = new Map();

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
  throw new Error(`devtools 未就绪（端口 ${PORT}）；可能有残留 Chrome 进程占用该端口`);
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
    // 页面可能有 beforeunload 提示，自动接受，避免脚本卡住。
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

async function waitUntil(expression, timeout = 10000, interval = 150) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeout) {
    try {
      const value = await evaljs(expression);
      if (value) return value;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(interval);
  }
  if (lastError) throw new Error(`等待超时（${timeout}ms）：${lastError}`);
  return null;
}

/** 反复读取一个值，直到 accept 通过或超时；返回最后一次读到的值（可能不满足）。 */
async function pollValue(read, accept, timeout = 10000, interval = 160) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await read();
    } catch {
      last = null;
    }
    if (last && accept(last)) return last;
    await sleep(interval);
  }
  return last;
}

async function goto(pathname) {
  const url = /^https?:\/\//i.test(pathname) ? pathname : BASE + pathname;
  try {
    await send('Page.navigate', { url });
  } catch (err) {
    // beforeunload 偶发把导航打断，重试一次。
    await sleep(400);
    await send('Page.navigate', { url }).catch(() => undefined);
  }
  await waitUntil(`document.readyState === 'complete'`, 15000).catch(() => undefined);
  await sleep(700);
}

/* ------------------------------------------------------------------ */
/* 页面上下文描述（断言失败时打印）                                     */
/* ------------------------------------------------------------------ */

async function describePage() {
  try {
    const info = await evaljs(`(() => {
      const visible = (el) => el.getClientRects().length > 0;
      const palette = [...document.querySelectorAll(${q(SEL.paletteItem)})]
        .filter(visible)
        .map((node) => (node.querySelector('strong')?.textContent ?? '').trim());
      const rows = [...document.querySelectorAll(${q(SEL.treeRow)})]
        .map((node) => (node.querySelector('.tree-meta')?.textContent ?? '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const frame = document.querySelector(${q(SEL.previewFrame)});
      const frameInfo = { present: false, accessible: false, blocks: 0, types: [] };
      if (frame) {
        frameInfo.present = true;
        try {
          const doc = frame.contentDocument;
          frameInfo.accessible = !!doc && !!doc.body;
          if (doc) {
            const sections = [...doc.querySelectorAll('section[data-pp-block]')];
            frameInfo.blocks = sections.length;
            frameInfo.types = sections.map((el) => el.getAttribute('data-block-type'));
          }
        } catch (err) {
          frameInfo.error = err.message;
        }
      }
      return {
        path: location.pathname + location.search,
        heading: (document.querySelector('h1, h2, h3')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        palette,
        rows: rows.slice(0, 24),
        frame: frameInfo,
        text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 220),
      };
    })()`);
    const frame = info.frame.present
      ? `${info.frame.accessible ? '可访问' : '不可访问'} ${info.frame.blocks} 个区块[${info.frame.types.join(',')}]`
      : '缺失';
    return [
      `页面=${info.path}${info.heading ? ` «${info.heading}»` : ''}`,
      `可见组件库=[${info.palette.join(', ')}]`,
      `结构树=[${info.rows.join(' | ')}]`,
      `预览 iframe=${frame}`,
      `可见文案=«${info.text || '（空）'}»`,
    ].join(' | ');
  } catch {
    return '页面=无法读取 DOM 概要（页面可能已崩溃或正在导航）';
  }
}

/** 失败时自动附带页面上下文。 */
async function check(section, name, ok, extra = '') {
  if (ok) {
    pass(section, name, extra);
    return true;
  }
  const context = await describePage();
  fail(section, name, [extra, context].filter(Boolean).join(' | '));
  return false;
}

/* ------------------------------------------------------------------ */
/* 操作辅助                                                            */
/* ------------------------------------------------------------------ */

async function fillInput(selector, value) {
  const result = await evaljs(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return { ok: false, reason: 'missing ' + ${q(selector)} };
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
  if (!result?.ok) throw new Error(`填不进去：${selector}（${result?.reason ?? 'unknown'}）`);
  return result.value;
}

/** 在 scope 里找文案匹配的可点击元素并点击（向导用）。 */
async function clickText(scopeSelector, pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const scope = scopeSelector ? `document.querySelector(${q(scopeSelector)})` : 'document';
  const result = await evaljs(`(() => {
    const root = ${scope};
    if (!root) return { ok: false, reason: 'scope 不存在: ' + ${q(scopeSelector ?? '')} };
    const re = new RegExp(${q(source)});
    const nodes = [...root.querySelectorAll('button, a, [role="button"], [role="tab"], [role="switch"], .option, .segmented button')];
    const visible = nodes.filter((el) => el.getClientRects().length > 0);
    const el = visible.find((node) => re.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!el) {
      return {
        ok: false,
        reason: '没有匹配 /' + ${q(String(pattern))} + '/ 的可点击元素',
        candidates: visible.map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 24)).filter(Boolean).slice(0, 14),
      };
    }
    el.click();
    return { ok: true, text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 36) };
  })()`);
  if (!result?.ok) {
    throw new Error(
      `找不到文案 /${String(pattern)}/ 的可点击元素${result?.candidates?.length ? `；候选: ${result.candidates.join(' | ')}` : ''}`,
    );
  }
  return result;
}

async function shot(name, scrollSelector = '') {
  if (!SHOTS_ENABLED) return '';
  try {
    if (scrollSelector) {
      await evaljs(`(() => {
        const el = document.querySelector(${q(scrollSelector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return true;
      })()`).catch(() => undefined);
      await sleep(350);
    }
    await mkdir(SHOTS_DIR, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    shots.push(file);
    logLine(`  [shot] ${file}`);
    return file;
  } catch (err) {
    logLine(`  [shot] 截图失败 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 安装引导 + 演示登录                                                  */
/* ------------------------------------------------------------------ */

async function readConfig() {
  return evaljs(`(() => {
    try { return JSON.parse(localStorage.getItem(${q(CONFIG_KEY)}) || 'null'); } catch { return null; }
  })()`);
}

async function clickWizardNext() {
  const result = await evaljs(`(() => {
    const buttons = [...document.querySelectorAll(${q(SEL.wizard)} + ' .wiz-actions button')];
    const button = buttons.find((node) => /继续/.test((node.textContent ?? '').trim())) ?? buttons[buttons.length - 1];
    if (!button) return { ok: false, reason: '没有安装向导按钮' };
    if (button.disabled) return { ok: false, reason: '按钮被禁用: ' + (button.textContent ?? '').trim() };
    button.click();
    return { ok: true, text: (button.textContent ?? '').replace(/\\s+/g, ' ').trim() };
  })()`);
  if (!result?.ok) throw new Error(`安装向导「继续」失败：${result?.reason ?? 'unknown'}`);
  await sleep(750);
}

async function runSetupWizard() {
  await waitUntil(`!!document.querySelector(${q(SEL.wizard)})`, 20000);
  await shot('00-setup-welcome');

  // 第 1 步：欢迎 + 主题选择
  await waitUntil(`(() => {
    const buttons = [...document.querySelectorAll(${q(SEL.wizard)} + ' .wiz-actions button')];
    return buttons.some((node) => /开始配置/.test(node.textContent ?? ''));
  })()`, 12000);
  await clickText(SEL.wizard, '开始配置');
  await sleep(800);

  // 第 2 步：运行方式 → 演示数据（本地）
  const demoSelected = await evaljs(`(() => {
    const demo = [...document.querySelectorAll(${q(SEL.wizard)} + ' .option')].find((node) => (node.textContent ?? '').includes('演示数据'));
    return demo ? demo.classList.contains('is-selected') : false;
  })()`);
  if (!demoSelected) {
    await clickText(SEL.wizard, '演示数据');
    await sleep(500);
  }
  await clickWizardNext();

  // 第 3 步：数据库（演示模式默认 SQLite）
  await clickWizardNext();

  // 第 4 步：管理员账户（演示模式只记录在本地）
  await waitUntil(`!!document.querySelector('#admin-email')`, 12000);
  await fillInput('#admin-name', ADMIN.name);
  await fillInput('#admin-email', ADMIN.email);
  await fillInput('#admin-pass', ADMIN.password);
  await fillInput('#admin-confirm', ADMIN.password);
  await clickText(SEL.wizard, '记录管理员账户');
  await sleep(500);
  await clickWizardNext();

  // 第 5 步：默认站点
  await clickWizardNext();

  // 第 6 步：登录方式（保持默认）
  await clickWizardNext();

  // 第 7 步：检查并完成
  const finishReady = await waitUntil(`(() => {
    const button = [...document.querySelectorAll(${q(SEL.wizard)} + ' .wiz-actions button')].find((node) => /完成安装/.test(node.textContent ?? ''));
    return button && !button.disabled;
  })()`, 20000);
  await check('SETUP', '安装向导走到第 7 步「检查与完成」且可完成', !!finishReady);
  await clickText(SEL.wizard, '完成安装');
  const installed = await waitUntil(`(() => {
    try {
      const config = JSON.parse(localStorage.getItem(${q(CONFIG_KEY)}) || 'null');
      return !!config && config.mode === 'demo' && config.setup_complete === true;
    } catch { return false; }
  })()`, 20000);
  return !!installed;
}

async function ensureLoggedIn() {
  await goto('/login');
  await sleep(600);
  const hasForm = await evaljs(`!!document.querySelector('input[type="email"]')`);
  if (!hasForm) {
    const loggedIn = await evaljs(`!!document.querySelector('.header-user, .user-trigger, a[href="/admin"]')`);
    await check('SETUP', '演示管理员已处于登录态', !!loggedIn);
    return !!loggedIn;
  }
  await fillInput('input[type="email"]', ADMIN.email);
  await fillInput('input[type="password"]', ADMIN.password);
  const submitted = await evaljs(`(() => {
    const form = document.querySelector('form');
    const button = [...document.querySelectorAll('button')].find((node) => node.type === 'submit' && /登录/.test(node.textContent ?? ''));
    if (button) { button.click(); return true; }
    if (form) { form.requestSubmit(); return true; }
    return false;
  })()`);
  if (!submitted) {
    await check('SETUP', '演示管理员登录', false, '登录表单没有提交按钮');
    return false;
  }
  const ok = await waitUntil(`(() => {
    const pathname = location.pathname;
    return pathname !== '/login' && (!!document.querySelector('.header-user, .user-trigger') || !!document.querySelector('a[href="/admin"]'));
  })()`, 12000);
  await check('SETUP', '演示管理员登录成功', !!ok, ok ? `当前页面=${await evaljs('location.pathname')}` : '仍停留在 /login');
  return !!ok;
}

/* ------------------------------------------------------------------ */
/* 页面编排工作台辅助                                                  */
/* ------------------------------------------------------------------ */

/** 在预览 iframe 内执行代码片段；片段里可用 `frame` 与 `doc`。 */
function frameExpr(body) {
  return `(() => {
    const frame = document.querySelector(${q(SEL.previewFrame)});
    if (!frame) return { ok: false, reason: '预览 iframe 不存在（.builder-preview iframe）' };
    let doc = null;
    try { doc = frame.contentDocument; } catch (err) { return { ok: false, reason: '预览 iframe 不可访问: ' + err.message }; }
    if (!doc || !doc.body) return { ok: false, reason: '预览 iframe 文档未就绪' };
    ${body}
  })()`;
}

/** 读预览 iframe 里按钮组件的存在与数量。 */
async function readFrameCounts() {
  return evaljs(frameExpr(`
    const sections = [...doc.querySelectorAll('section[data-pp-block]')];
    const buttonSection = doc.querySelector(${q(SEL.buttonSection)});
    return {
      ok: true,
      buttonSection: !!buttonSection,
      actionButtons: buttonSection ? buttonSection.querySelectorAll('.pp-action-btn').length : 0,
      types: sections.map((el) => el.getAttribute('data-block-type')),
    };
  `));
}

/** 读预览 iframe 里按钮区块的计算样式。 */
async function readButtonComputed() {
  return evaljs(frameExpr(`
    const el = doc.querySelector(${q(SEL.buttonSection)});
    if (!el) {
      return {
        ok: false,
        reason: '预览 iframe 里没有 ' + ${q(SEL.buttonSection)},
        types: [...doc.querySelectorAll('section[data-pp-block]')].map((node) => node.getAttribute('data-block-type')),
      };
    }
    const cs = frame.contentWindow.getComputedStyle(el);
    return {
      ok: true,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      overflow: cs.overflow,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      aspectRatio: cs.aspectRatio,
      padding: cs.padding,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      backgroundColor: cs.backgroundColor,
      inlineStyle: el.getAttribute('style') || '',
    };
  `));
}

/** 在预览 iframe 内把某个区块滚到可视区域（只为截图取证）。 */
async function scrollFrameTo(selector) {
  const result = await evaljs(frameExpr(`
    const target = doc.querySelector(${q(selector)});
    if (!target) return { ok: false, reason: 'iframe 里没有 ' + ${q(selector)} };
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { ok: true };
  `)).catch(() => null);
  await sleep(450);
  return result;
}

/**
 * 点组件库里的组件。
 * 按钮在「内容」分组，该 <details> 默认收起，所以先全部展开再按名字找。
 */
async function clickPalette(names) {
  return evaljs(`(() => {
    const names = ${JSON.stringify(names)};
    // 「内容」组默认收起；直接操作 DOM 展开，保证按钮可点击。
    for (const group of document.querySelectorAll(${q(SEL.paletteGroup)})) group.open = true;
    const items = [...document.querySelectorAll(${q(SEL.paletteItem)})];
    const labelOf = (node) => (node.querySelector('strong')?.textContent ?? node.textContent ?? '').trim();
    const hit = items.find((node) => {
      const label = labelOf(node);
      return names.some((name) => label === name || label.includes(name));
    });
    if (!hit) {
      return {
        ok: false,
        reason: '组件库里没有 ' + names.join('/'),
        candidates: items.map(labelOf).filter(Boolean).slice(0, 40),
      };
    }
    const label = labelOf(hit);
    hit.click();
    return { ok: true, label };
  })()`);
}

/**
 * 在右侧属性面板给按钮区块追加一条按钮，并填上文字 / 链接。
 *
 * 按钮区块的默认值现在是空列表（`buttons: []`）：新建之后预览里还没有
 * `.pp-action-btn`，必须先在这里补内容。行内输入框用 aria-label 定位
 * （`按钮 第 N 条 文字` / `按钮 第 N 条 链接`，见 components/builder/BlockProps.tsx）。
 */
async function addButtonRow(index, label, link) {
  const row = index + 1;
  const added = await evaljs(`(() => {
    const addBtn = [...document.querySelectorAll('.builder-inspector .itemlist button')]
      .find((node) => (node.textContent ?? '').trim() === '添加按钮');
    if (!addBtn) {
      return {
        ok: false,
        reason: '属性面板里没有「添加按钮」',
        inspector: (document.querySelector('.builder-inspector')?.innerText ?? '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 160),
      };
    }
    if (addBtn.disabled) return { ok: false, reason: '「添加按钮」已禁用（可能已达上限）' };
    addBtn.click();
    return { ok: true };
  })()`);
  if (!added?.ok) {
    throw new Error(`追加第 ${row} 个按钮失败：${added?.reason ?? 'unknown'}${added?.inspector ? `；面板文案=«${added.inspector}»` : ''}`);
  }

  const labelSelector = `[aria-label="按钮 第 ${row} 条 文字"]`;
  const linkSelector = `[aria-label="按钮 第 ${row} 条 链接"]`;
  const ready = await waitUntil(`!!document.querySelector(${q(labelSelector)})`, 8000);
  if (!ready) throw new Error(`第 ${row} 个按钮的输入框没有出现（${labelSelector}）`);
  await fillInput(labelSelector, label);
  await fillInput(linkSelector, link);
  await sleep(150);
  return true;
}

/** 在左侧结构树里按区块类型（.tree-meta 里的 type）选中一行。 */
async function selectTreeRow(type) {
  return evaljs(`(() => {
    const rows = [...document.querySelectorAll(${q(SEL.treeRow)})];
    const metaOf = (row) => (row.querySelector('.tree-meta')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const hit = rows.find((row) => metaOf(row).includes(${q(type)}));
    if (!hit) {
      return {
        ok: false,
        reason: '结构树里没有 type=' + ${q(type)} + ' 的行',
        rows: rows.map(metaOf).filter(Boolean).slice(0, 24),
      };
    }
    hit.click();
    return { ok: true };
  })()`);
}

/** 设置下拉框 / 数字框 / 色板，并派发 input + change（React onChange 两种都要）。 */
async function setAppearanceControl(selector, value) {
  const result = await evaljs(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) {
      return {
        ok: false,
        reason: '缺失外观控件 ' + ${q(selector)},
        appearanceIds: [...document.querySelectorAll('[id^="appearance-"]')].map((node) => node.id),
      };
    }
    const tag = el.tagName;
    if (tag !== 'SELECT' && tag !== 'INPUT') return { ok: false, reason: '不支持的元素: ' + tag };
    const proto = tag === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    // React 会在 input 实例上挂自己的 value tracker，走原型 setter 绕过它；
    // 个别环境没有原型访问器时退回直接赋值。
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${q(String(value))});
    else el.value = ${q(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
  if (!result?.ok) {
    throw new Error(`设置 ${selector} 失败：${result?.reason ?? 'unknown'}${result?.appearanceIds?.length ? `；现有外观控件: ${result.appearanceIds.join(', ')}` : ''}`);
  }
  await sleep(120);
  return result;
}

function normalizeAspectRatio(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function isExpectedBackground(value) {
  return /^rgba?\(238,\s*243,\s*239(?:,\s*1(?:\.0+)?)?\)$/i.test(String(value ?? '').trim());
}

/** 五个外观断言全部成立时为 true。 */
function appearanceSatisfied(style) {
  if (!style?.ok) return false;
  return (
    style.borderRadius === EXPECT.borderRadius &&
    !!style.boxShadow &&
    style.boxShadow !== 'none' &&
    style.overflow === 'hidden' &&
    normalizeAspectRatio(style.aspectRatio) === EXPECT.aspectRatio &&
    style.padding === EXPECT.padding &&
    isExpectedBackground(style.backgroundColor)
  );
}

/* ------------------------------------------------------------------ */
/* 验收主流程                                                          */
/* ------------------------------------------------------------------ */

async function ensureReachable() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `无法访问 PP_E2E_BASE=${BASE}（${err instanceof Error ? err.message : String(err)}）。` +
        `请先在 apps/web 执行 npm run build，并让 node scripts/serve.mjs --port 8099 运行。`,
    );
  }
}

/** 1. 全新安装 + 演示管理员登录。 */
async function prepareEnvironment() {
  console.log('\n=== 准备：七步安装向导（演示数据）+ 演示管理员登录 ===');
  await goto('/');
  await evaljs('localStorage.clear(); sessionStorage.clear(); true');
  await goto('/', 1600);

  const installed = await runSetupWizard();
  const config = await readConfig();
  await check(
    'SETUP',
    '安装完成并写入 pp.web.config.v1（演示模式）',
    !!installed && !!config && config.mode === 'demo',
    config ? `mode=${config.mode} site_id=${config.site_id}` : '配置为空',
  );
  if (!installed) return false;

  return ensureLoggedIn();
}

/** 2–5. 页面编排：加按钮 / 组件库回归、改外观、读计算样式。 */
async function runBuilderChecks() {
  console.log('\n=== A. 页面编排工作台 + 组件库 ===');
  await goto('/admin/theme');
  const paletteReady = await waitUntil(`!!document.querySelector(${q(SEL.palette)})`, 30000);
  await check('BUILDER', '打开 /admin/theme 并出现组件库 .builder-palette', !!paletteReady);
  if (!paletteReady) throw new Error('页面编排工作台没有加载出来（.builder-palette 缺失）');

  const frameReady = await waitUntil(`(() => {
    const frame = document.querySelector(${q(SEL.previewFrame)});
    if (!frame) return false;
    try {
      const doc = frame.contentDocument;
      return !!doc && doc.readyState === 'complete' && !!doc.body;
    } catch { return false; }
  })()`, 30000);
  await check('BUILDER', '真实前台预览 iframe 已就绪且同源可访问', !!frameReady);
  if (!frameReady) throw new Error('预览 iframe 没有就绪（.builder-preview iframe）');
  await shot('01-builder-initial');

  console.log('\n=== B. 组件库 → 按钮区块 → 属性面板补两个按钮 ===');
  let buttonAdded = false;
  try {
    const added = await clickPalette(['按钮', 'Button']);
    buttonAdded = added?.ok === true;
    await check(
      'BUTTON',
      '组件库里有「按钮」并可点击追加',
      buttonAdded,
      added?.ok ? `组件=${added.label}` : `${added?.reason ?? 'unknown'}${added?.candidates?.length ? `；候选: ${added.candidates.join(' / ')}` : ''}`,
    );
    if (buttonAdded) {
      // 新按钮区块的 buttons 默认是空数组，所以「加完就有按钮」这条断言不再成立；
      // 先走属性面板的表单补两条，再断言预览渲染。
      let filled = 0;
      try {
        const panelReady = await waitUntil(`!!document.querySelector('.builder-inspector .itemlist')`, 12000);
        if (!panelReady) throw new Error('右侧属性面板没有出现按钮列表（.builder-inspector .itemlist）');
        await addButtonRow(0, '立即阅读', '/articles');
        filled = 1;
        await addButtonRow(1, '关于我们', '/about');
        filled = 2;
        await check('BUTTON', '属性面板里填好两个按钮（文字 + 链接）', true, '立即阅读→/articles，关于我们→/about');
      } catch (err) {
        await check(
          'BUTTON',
          '属性面板里填好两个按钮（文字 + 链接）',
          false,
          `${err instanceof Error ? err.message : String(err)}（已填 ${filled}/2）`,
        );
      }
      if (filled === 2) {
        const counts = await pollValue(
          readFrameCounts,
          (value) => value?.ok && value.actionButtons >= 2,
          15000,
        );
        await check(
          'BUTTON',
          '预览 iframe 的按钮区块渲染两个 .pp-action-btn',
          (counts?.actionButtons ?? 0) >= 2,
          `按钮=${counts?.actionButtons ?? 0}`,
        );
      }
    }
  } catch (err) {
    await check('BUTTON', '按钮区块验收未中断', false, err instanceof Error ? err.message : String(err));
  }
  await shot('02-button-added');

  console.log('\n=== C. 负向断言：组件库里没有「思维导图」（已迁到文章写作） ===');
  const paletteItems = await evaljs(`(() => {
    // 「内容」组默认收起，但子节点仍在 DOM 里；直接读全部 .palette-item 的文案。
    for (const group of document.querySelectorAll(${q(SEL.paletteGroup)})) group.open = true;
    const items = [...document.querySelectorAll(${q(SEL.paletteItem)})];
    const labelOf = (node) => (node.querySelector('strong')?.textContent ?? node.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const labels = items.map(labelOf).filter(Boolean);
    return {
      labels,
      mindmap: labels.filter((label) => label.includes('思维导图') || /mind ?map/i.test(label)),
    };
  })()`);
  await check(
    'PALETTE',
    '组件库 .palette-item 文案里没有「思维导图 / Mind map」',
    !!paletteItems && paletteItems.mindmap.length === 0,
    paletteItems
      ? `命中=[${paletteItems.mindmap.join(' / ')}]；组件=${paletteItems.labels.length} 项`
      : '读不到 .palette-item',
  );
  await check(
    'PALETTE',
    '按钮区块仍在组件库里',
    !!paletteItems && paletteItems.labels.some((label) => label === '按钮' || /^按钮/.test(label)),
    paletteItems ? `组件库=[${paletteItems.labels.slice(0, 30).join(', ')}]` : '读不到 .palette-item',
  );
  await shot('03-palette-no-mindmap', SEL.palette);

  console.log('\n=== D. 结构树选中按钮区块 + 设置通用外观 ===');
  const selected = await selectTreeRow('button');
  await check(
    'APPEARANCE',
    '左侧结构树选中按钮区块（.tree-row type=button）',
    selected?.ok === true,
    selected?.ok ? '' : `${selected?.reason ?? 'unknown'}${selected?.rows?.length ? `；现有行: ${selected.rows.join(' | ')}` : ''}`,
  );

  if (selected?.ok) {
    const controls = [
      ['radius', SEL.appearance.radius, APPEARANCE.radius, 'lg'],
      ['shadow', SEL.appearance.shadow, APPEARANCE.shadow, 'md'],
      ['crop', SEL.appearance.crop, APPEARANCE.crop, '16:9'],
      ['padding', SEL.appearance.padding, APPEARANCE.padding, '16'],
      ['background', SEL.appearance.background, APPEARANCE.background, '#eef3ef'],
    ];
    let applied = 0;
    for (const [key, selector, value, label] of controls) {
      try {
        await setAppearanceControl(selector, value);
        applied += 1;
        await check('APPEARANCE', `外观「${key}」设置为 ${label}`, true, selector);
      } catch (err) {
        await check('APPEARANCE', `外观「${key}」设置为 ${label}`, false, err instanceof Error ? err.message : String(err));
      }
    }
    await check('APPEARANCE', '5 项外观控件全部写入', applied === controls.length, `${applied}/${controls.length}`);
    await shot('04-appearance-panel', SEL.appearance.radius);

    console.log('\n=== E. iframe 内按钮区块计算样式（storage 同步有数帧延迟，轮询） ===');
    const style = await pollValue(readButtonComputed, appearanceSatisfied, 12000);
    await check('APPEARANCE', 'iframe 里找到按钮区块并读到计算样式', style?.ok === true, style?.ok ? '' : String(style?.reason ?? 'unknown'));
    if (style?.ok) {
      await check(
        'APPEARANCE',
        'borderRadius = 16px（圆角 lg）',
        style.borderRadius === EXPECT.borderRadius,
        `实际=${style.borderRadius}`,
      );
      await check(
        'APPEARANCE',
        'boxShadow 非 none（阴影 md）',
        !!style.boxShadow && style.boxShadow !== 'none',
        `实际=${style.boxShadow}`,
      );
      await check(
        'APPEARANCE',
        'overflow = hidden（裁剪 16:9）',
        style.overflow === 'hidden',
        `实际=${style.overflow}（x=${style.overflowX} y=${style.overflowY}）`,
      );
      await check(
        'APPEARANCE',
        'aspectRatio 含 16/9（裁剪 16:9）',
        normalizeAspectRatio(style.aspectRatio) === EXPECT.aspectRatio,
        `实际=${style.aspectRatio}`,
      );
      await check(
        'APPEARANCE',
        'padding = 16px（内边距 16）',
        style.padding === EXPECT.padding,
        `实际=${style.padding}`,
      );
      await check(
        'APPEARANCE',
        'backgroundColor = rgb(238, 243, 239)（#eef3ef）',
        isExpectedBackground(style.backgroundColor),
        `实际=${style.backgroundColor}`,
      );
      if (!appearanceSatisfied(style)) {
        logLine(`  内联样式：${style.inlineStyle || '（空）'}`);
      }
    }
    await scrollFrameTo(SEL.buttonSection);
    await shot('05-button-appearance');
  }

  /* ---------- F. localStorage 落盘断言 ---------- */
  console.log('\n=== F. localStorage 配置落盘 ===');
  const config = await readConfig();
  const homeBlocks = config?.customization?.home?.blocks ?? [];
  const allBlocks = flattenBlocks(homeBlocks);
  const types = [...new Set(allBlocks.map((block) => block.type))];
  const buttonBlock = allBlocks.find((block) => block.type === 'button');
  await check('CONFIG', 'pp.web.config.v1.customization.home.blocks 是数组', Array.isArray(homeBlocks), `区块类型=[${types.join(', ')}]`);
  await check('CONFIG', '配置里存在 type=button 区块', !!buttonBlock, `顶层=${homeBlocks.length} 全部=${allBlocks.length}`);
  await check(
    'CONFIG',
    '配置里不再出现 type=mindmap 区块（思维导图已迁到文章写作）',
    !allBlocks.some((block) => block.type === 'mindmap'),
    `区块类型=[${types.join(', ')}]`,
  );
  const appearance = buttonBlock?.appearance ?? {};
  await check(
    'CONFIG',
    '按钮 appearance 已写入（radius/shadow/crop/padding/background）',
    appearance.radius === APPEARANCE.radius &&
      appearance.shadow === APPEARANCE.shadow &&
      appearance.crop === APPEARANCE.crop &&
      appearance.padding === Number(APPEARANCE.padding) &&
      String(appearance.background ?? '').toLowerCase() === APPEARANCE.background,
    `appearance=${JSON.stringify(appearance)}`,
  );
  const savedButtons = Array.isArray(buttonBlock?.props?.buttons) ? buttonBlock.props.buttons : [];
  await check(
    'CONFIG',
    '配置里按钮区块保存了两个按钮（文字 + 链接）',
    savedButtons.length === 2 &&
      savedButtons[0]?.label === '立即阅读' &&
      savedButtons[0]?.link === '/articles' &&
      savedButtons[1]?.label === '关于我们' &&
      savedButtons[1]?.link === '/about',
    `buttons=${JSON.stringify(savedButtons)}`,
  );

  /* ---------- G. 刷新后仍在 ---------- */
  console.log('\n=== G. 刷新后重新打开 /admin/theme ===');
  await goto('/admin/theme');
  const paletteAgain = await waitUntil(`!!document.querySelector(${q(SEL.palette)})`, 30000);
  await check('PERSIST', '刷新后页面编排工作台重新打开', !!paletteAgain);
  if (!paletteAgain) return;
  const frameAgain = await waitUntil(`(() => {
    const frame = document.querySelector(${q(SEL.previewFrame)});
    if (!frame) return false;
    try {
      const doc = frame.contentDocument;
      return !!doc && doc.readyState === 'complete' && !!doc.body;
    } catch { return false; }
  })()`, 30000);
  await check('PERSIST', '刷新后预览 iframe 重新就绪', !!frameAgain);

  const configAgain = await readConfig();
  const blocksAgain = flattenBlocks(configAgain?.customization?.home?.blocks ?? []);
  const buttonAgain = blocksAgain.find((block) => block.type === 'button');
  await check('PERSIST', '刷新后配置里仍有 type=button 区块', !!buttonAgain);
  await check(
    'PERSIST',
    '刷新后配置里没有 type=mindmap 区块',
    !blocksAgain.some((block) => block.type === 'mindmap'),
    `区块类型=[${[...new Set(blocksAgain.map((block) => block.type))].join(', ')}]`,
  );
  const appearanceAgain = buttonAgain?.appearance ?? {};
  await check(
    'PERSIST',
    '刷新后按钮 appearance 仍在',
    appearanceAgain.radius === APPEARANCE.radius &&
      appearanceAgain.shadow === APPEARANCE.shadow &&
      appearanceAgain.crop === APPEARANCE.crop &&
      appearanceAgain.padding === Number(APPEARANCE.padding) &&
      String(appearanceAgain.background ?? '').toLowerCase() === APPEARANCE.background,
    `appearance=${JSON.stringify(appearanceAgain)}`,
  );
  const buttonsAgain = Array.isArray(buttonAgain?.props?.buttons) ? buttonAgain.props.buttons : [];
  await check(
    'PERSIST',
    '刷新后配置里两个按钮仍在（文字 + 链接）',
    buttonsAgain.length === 2 &&
      buttonsAgain[0]?.label === '立即阅读' &&
      buttonsAgain[1]?.link === '/about',
    `buttons=${JSON.stringify(buttonsAgain)}`,
  );

  const countsAgain = await pollValue(
    readFrameCounts,
    (value) => value?.ok && value.actionButtons >= 2,
    15000,
  );
  await check('PERSIST', '刷新后预览 iframe 仍渲染两个 .pp-action-btn', (countsAgain?.actionButtons ?? 0) >= 2, `按钮=${countsAgain?.actionButtons ?? 0}`);

  const styleAgain = await pollValue(readButtonComputed, appearanceSatisfied, 12000);
  await check(
    'PERSIST',
    '刷新后按钮外观仍落在计算样式上',
    appearanceSatisfied(styleAgain),
    styleAgain?.ok
      ? `圆角=${styleAgain.borderRadius} 阴影=${styleAgain.boxShadow === 'none' ? 'none' : '有'} overflow=${styleAgain.overflow} 比例=${styleAgain.aspectRatio} 内边距=${styleAgain.padding} 背景=${styleAgain.backgroundColor}`
      : String(styleAgain?.reason ?? 'unknown'),
  );
  await scrollFrameTo(SEL.buttonSection);
  await shot('06-after-reload-button');
}

function flattenBlocks(blocks, out = []) {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    out.push(block);
    if (Array.isArray(block.children)) flattenBlocks(block.children, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function printSummary() {
  const sections = ['SETUP', 'BUILDER', 'BUTTON', 'PALETTE', 'APPEARANCE', 'CONFIG', 'PERSIST', 'RUN'];
  console.log('\n================ 汇总 ================');
  for (const section of sections) {
    const items = results.filter((item) => item.section === section);
    if (!items.length) continue;
    const ok = items.filter((item) => item.ok).length;
    console.log(`${section}  ${ok === items.length ? 'PASS' : 'FAIL'}  ${ok}/${items.length}`);
  }
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  console.log(`\nPASS ${passed} / FAIL ${failed.length}`);
  if (failed.length) {
    console.log('\n失败清单：');
    for (const item of failed) {
      console.log(`  - [${item.section}] ${item.name}${item.extra ? ` · ${item.extra}` : ''}`);
    }
  }
  if (shots.length) {
    console.log(`\n截图 ${shots.length} 张（${SHOTS_DIR}）：`);
    for (const file of shots) console.log(`  - ${file}`);
  }
  if (!SHOTS_ENABLED) console.log('\n（PP_E2E_SHOTS=0，已跳过截图）');
  console.log('');
  return failed.length;
}

async function main() {
  await ensureReachable();
  await mkdir(TMP, { recursive: true });
  await startChrome();
  try {
    await connectPage();

    let ready = false;
    try {
      ready = await prepareEnvironment();
    } catch (err) {
      await check('SETUP', '环境准备未中断（安装/登录）', false, err instanceof Error ? err.message : String(err));
    }
    if (!ready) {
      fail('RUN', '准备环境', '演示管理员未就绪，跳过页面编排验收');
      return;
    }

    currentSection = 'BUILDER';
    try {
      await runBuilderChecks();
    } catch (err) {
      await check('RUN', '页面编排验收未中断', false, err instanceof Error ? err.message : String(err));
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
    try {
      chromeProc?.kill();
    } catch {
      /* 忽略 */
    }
  }
}

try {
  await main();
} catch (err) {
  console.log(`\nERROR ${err instanceof Error ? err.message : String(err)}`);
  fail('RUN', '脚本启动 / 环境', err instanceof Error ? err.message : String(err));
}

const failedCount = printSummary();
process.exit(failedCount ? 1 : 0);
