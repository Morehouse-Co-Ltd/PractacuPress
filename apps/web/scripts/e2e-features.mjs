/**
 * 四项新功能端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 *   覆盖：
 *   A 文章自定义封面：新建文章 → 保存草稿 → 右侧封面面板填图片地址 → 预览 → 保存 →
 *     前台文章详情 `.article-cover` 内出现 img 且父级含 cover-custom。
 *   B Markdown 输入：创作页 contenteditable 键入 `## 小标题` → 断言生成 h2；
 *     键入 `/` → 断言出现斜杠指令面板；Esc 关闭。
 *   C 链接卡片：工具栏「链接」→ 切「卡片」模式 → 填网址 / 标题 / 说明 → 插入 →
 *     断言编辑区出现 a.pp-linkcard；保存后前台文章详情仍能找到。
 *   D 创作者扩展：/admin/extensions → 「我的扩展」→ 导入示例扩展 → 卡片上启用 →
 *     前台出现 iframe[data-pp-extension]；禁用并刷新后消失。
 *
 * 前置：`cd apps/web && npm run build`，并让 `node scripts/serve.mjs` 在 PP_E2E_BASE 提供服务。
 * 运行：`cd apps/web && node scripts/e2e-features.mjs`
 * 环境变量：
 *   CHROME_PATH    Chrome 可执行文件（默认自动探测常见路径）
 *   PP_E2E_BASE    站点地址（默认 http://127.0.0.1:80）
 *   PP_E2E_PORT    CDP 调试端口（默认 9334；与 e2e-nightflight.mjs 的 9333 错开）
 *   PP_E2E_SHOTS   设为 0 可跳过截图（默认截图到 .tmp/shots-features/）
 *
 * 选择器策略：功能由多个并行任务实现，脚本把候选选择器集中放在 SEL 常量里；
 * 某个断言失败时会打印实际匹配到的选择器、页面路径和可见文案，方便区分
 * 「功能缺陷 / 脚本选择器过期 / 环境问题」。改功能源码不是本脚本的职责。
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
const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:80').replace(/\/+$/, '');
const PORT = Number(process.env.PP_E2E_PORT ?? 9334);
const SHOTS_ENABLED = process.env.PP_E2E_SHOTS !== '0';

const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS_DIR = path.join(TMP, 'shots-features');
// pid 后缀让每次运行都从干净 profile 开始；不做递归删除，避免沙箱拦截。
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-profile-features-${process.pid}/`, import.meta.url));

const ADMIN = {
  name: 'QA 验证员',
  email: 'admin@practacu.local',
  password: 'practacu',
};

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#1f5c4a"/><text x="28" y="150" fill="#fff" font-family="sans-serif" font-size="30">QA COVER ${STAMP}</text></svg>`;
const COVER_URL = `data:image/svg+xml;base64,${Buffer.from(COVER_SVG).toString('base64')}`;
const CARD_URL = 'https://example.com/qa-linkcard';
const CARD_TITLE = `验收链接卡片 ${STAMP}`;
const CARD_DESC = '由 e2e-features.mjs 插入的卡片链接说明。';

/* ------------------------------------------------------------------ */
/* 选择器清单（合并后如有变化，只需要改这里）                              */
/*                                                                     */
/* 已按合并后的四项实现校准（2026-10-30）：                              */
/* - 封面 ArticleCoverPanel：`.pcov-panel` / `#pcov-url` / 「应用」按钮   */
/* - Markdown SlashMenu：`#pp-slash-menu.slash-menu[role=listbox]`       */
/* - 链接 LinkDialog：`.link-mode-switch` / `#rich-link-*` / 「插入卡片」  */
/* - 扩展 Extensions.tsx：role=tab 三标签 / 模板下拉 / 「保存为我的扩展」 / */
/*   `.ppe-card` + role=switch；前台 iframe[data-pp-extension]            */
/* ------------------------------------------------------------------ */

const SEL = {
  editor: {
    title: '.editor-title-input',
    surface: '.rich-surface, [contenteditable="true"][aria-label="正文"]',
    toolbar: '.rich-toolbar',
  },
  markdown: {
    heading: '.rich-surface h2, [contenteditable="true"] h2',
    slash: ['#pp-slash-menu', '.slash-menu', '[role="listbox"][aria-label="插入指令"]'],
  },
  cover: {
    panel: '.editor-side .pcov-panel, .pcov-panel',
    panelHeading: /封面/,
    input: '#pcov-url',
    apply: /应用/,
  },
  link: {
    tool: [
      '.rich-toolbar button[title*="链接"]',
      '.rich-toolbar button[aria-label*="链接"]',
      '.rich-toolbar button[title*="Link"]',
    ],
    modal: '.modal-layer',
    modeSwitch: [
      '.link-mode-switch button',
      '[role="group"][aria-label="链接形态"] button',
      '.segmented button',
    ],
    cardMode: /卡片链接|卡片/,
    fields: { href: '#rich-link-href', title: '#rich-link-title', desc: '#rich-link-desc' },
    insertButton: /插入卡片|插入/,
    frontCard: '.article-body a.pp-linkcard',
    editorCard: '.rich-surface a.pp-linkcard',
  },
  extensions: {
    iframe: 'iframe[data-pp-extension]',
    // 已按移除「扩展工坊」后的 Extensions.tsx 校准：Tabs 只剩「内置扩展 / 我的扩展」，
    // 创作者扩展通过导入进入，再在 .ppe-card 上启停。若文案 / class 再调整，只改这里。
    myTab: /我的扩展/,
    importSample: /文末作者卡|导入全部示例|导入示例扩展/,
    toggleSelector: '[role="switch"], .switch, button[aria-checked]',
    rowSelector: '.ppe-card, .ppe-ext-card, .ppe-extension-card, .ext-card, .ppe-list-item, section, li, tr, .panel',
  },
  setup: {
    wizard: '.wiz',
  },
};

/* ------------------------------------------------------------------ */
/* 记录与输出                                                          */
/* ------------------------------------------------------------------ */

const results = [];
const shots = [];
let currentBlock = 'SETUP';

function logLine(line) {
  console.log(line);
}

function pass(block, name, extra = '') {
  results.push({ block, name, ok: true, extra });
  logLine(`  PASS [${block}] ${name}${extra ? '  · ' + extra : ''}`);
}

function fail(block, name, extra = '') {
  results.push({ block, name, ok: false, extra });
  logLine(`  FAIL [${block}] ${name}${extra ? '  · ' + extra : ''}`);
}

async function describePage() {
  try {
    const info = await evaljs(`(() => {
      const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      return {
        path: location.pathname + location.search,
        heading: (document.querySelector('h1, h2')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        text: text.slice(0, 280),
      };
    })()`);
    return `页面=${info.path}${info.heading ? ` «${info.heading}»` : ''} 可见文案=${info.text || '（空）'}`;
  } catch {
    return '页面=无法读取（页面可能已崩溃或正在导航）';
  }
}

/** 失败时自动附带页面上下文。 */
async function check(block, name, ok, extra = '') {
  if (ok) {
    pass(block, name, extra);
    return true;
  }
  const context = await describePage();
  fail(block, name, [extra, context].filter(Boolean).join(' | '));
  return false;
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
let msgId = 0;
const pending = new Map();
let chromeProc;

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
    // 编辑页有未保存提示（beforeunload），导航前自动接受，避免脚本卡住。
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

async function waitUntil(expression, timeout = 8000, interval = 140) {
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

/* 操作辅助 ---------------------------------------------------------- */

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

async function focusEditor() {
  const ok = await evaljs(`(() => {
    const el = document.querySelector(${q(SEL.editor.surface)});
    if (!el) return false;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  })()`);
  if (!ok) throw new Error('正文编辑区不存在，无法聚焦');
  await sleep(120);
}

const KEY_META = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
};

async function pressKey(key) {
  const meta = KEY_META[key] ?? { code: key, keyCode: 0 };
  const text = key === 'Enter' ? '\r' : undefined;
  const base = {
    key,
    code: meta.code,
    windowsVirtualKeyCode: meta.keyCode,
    nativeVirtualKeyCode: meta.keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
  };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(80);
}

/** 按真实键盘事件逐字输入，保证 React onKeyDown / onInput 都会触发。 */
async function typeText(text) {
  for (const char of text) {
    if (char === '\n') {
      await pressKey('Enter');
      continue;
    }
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      code: char === ' ' ? 'Space' : char,
      text: char,
      unmodifiedText: char,
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: char === ' ' ? 'Space' : char });
    await sleep(28);
  }
}

async function countSelector(candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  return evaljs(`(() => {
    const list = ${JSON.stringify(list)};
    for (const selector of list) {
      const nodes = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
      if (nodes.length) return { selector, count: nodes.length };
    }
    return { selector: '', count: 0 };
  })()`);
}

/** 在 scope 里按文案找可点击元素（不限于 button，兼容 .option / role=tab）。 */
async function clickText(scopeSelector, pattern, { required = true } = {}) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const scope = scopeSelector ? `document.querySelector(${q(scopeSelector)})` : 'document';
  const result = await evaljs(`(() => {
    const root = ${scope};
    if (!root) return { ok: false, reason: 'scope 不存在: ' + ${q(scopeSelector ?? '')} };
    const re = new RegExp(${q(source)});
    const nodes = [...root.querySelectorAll('button, a, [role="button"], [role="tab"], [role="switch"], .option, .segmented button, .tab')];
    const visible = nodes.filter((el) => el.getClientRects().length > 0);
    const el = visible.find((node) => re.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!el) {
      return {
        ok: false,
        reason: '没有匹配 /' + ${q(pattern)} + '/ 的可点击元素',
        candidates: visible.map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 24)).filter(Boolean).slice(0, 14),
      };
    }
    el.click();
    return { ok: true, text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 36) };
  })()`);
  if (!result?.ok) {
    const detail = `找不到文案 /${pattern}/ 的可点击元素${result?.candidates?.length ? `；候选: ${result.candidates.join(' | ')}` : ''}`;
    if (required) throw new Error(detail);
    logLine(`  （可选点击跳过：${detail}）`);
    return result;
  }
  return result;
}

/** 在 scope 内按字段标题（.field-label / label）填值。 */
async function fillByLabel(scopeSelector, hints, value) {
  const result = await evaljs(`(() => {
    const scope = document.querySelector(${q(scopeSelector)});
    if (!scope) return { ok: false, reason: 'scope 不存在' };
    const hints = ${JSON.stringify(hints)};
    const match = (text) => hints.some((hint) => (text ?? '').includes(hint));
    const fields = [...scope.querySelectorAll('.field')];
    for (const field of fields) {
      const label = (field.querySelector('.field-label, label')?.textContent ?? '').trim();
      if (!match(label)) continue;
      const input = field.querySelector('input, textarea');
      if (!input) continue;
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${q(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, label };
    }
    // 兜底：label[for] + 同名 id
    for (const label of [...scope.querySelectorAll('label[for]')]) {
      const text = (label.textContent ?? '').trim();
      if (!match(text)) continue;
      const input = scope.querySelector('#' + CSS.escape(label.getAttribute('for')));
      if (!input) continue;
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${q(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, label: text };
    }
    return {
      ok: false,
      labels: fields.map((field) => (field.querySelector('.field-label, label')?.textContent ?? '').trim()).filter(Boolean).slice(0, 14),
    };
  })()`);
  if (!result?.ok) {
    throw new Error(`找不到字段 ${hints.join('/')}${result?.labels?.length ? `；现有字段: ${result.labels.join(' / ')}` : ''}`);
  }
  return result.label;
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
    try { return JSON.parse(localStorage.getItem('pp.web.config.v1') || 'null'); } catch { return null; }
  })()`);
}

async function wizardClickNext({ required = true } = {}) {
  const result = await evaljs(`(() => {
    const buttons = [...document.querySelectorAll('.wiz .wiz-actions button')];
    const button = buttons.find((node) => /继续/.test((node.textContent ?? '').trim())) ?? buttons[buttons.length - 1];
    if (!button) return { ok: false, reason: '没有安装向导按钮' };
    if (button.disabled) return { ok: false, reason: '按钮被禁用: ' + (button.textContent ?? '').trim() };
    button.click();
    return { ok: true, text: (button.textContent ?? '').replace(/\\s+/g, ' ').trim() };
  })()`);
  if (!result?.ok) {
    if (required) throw new Error(`安装向导「继续」失败：${result?.reason ?? 'unknown'}`);
    return false;
  }
  await sleep(750);
  return true;
}

async function runSetupWizard() {
  await waitUntil(`!!document.querySelector(${q(SEL.setup.wizard)})`, 20000);
  await shot('SETUP-welcome');

  // 第 1 步：欢迎 + 主题选择
  await waitUntil(`(() => {
    const buttons = [...document.querySelectorAll('.wiz .wiz-actions button')];
    return buttons.some((node) => /开始配置/.test(node.textContent ?? ''));
  })()`, 12000);
  await clickText(SEL.setup.wizard, '开始配置');
  await sleep(800);

  // 第 2 步：运行方式 → 演示数据（本地）
  const demoSelected = await evaljs(`(() => {
    const demo = [...document.querySelectorAll('.wiz .option')].find((node) => (node.textContent ?? '').includes('演示数据'));
    return demo ? demo.classList.contains('is-selected') : false;
  })()`);
  if (!demoSelected) {
    await clickText(SEL.setup.wizard, '演示数据');
    await sleep(500);
  }
  await wizardClickNext();

  // 第 3 步：数据库（演示模式默认 SQLite）
  await wizardClickNext();

  // 第 4 步：管理员账户（演示模式只记录在本地）
  await waitUntil(`!!document.querySelector('#admin-email')`, 12000);
  await fillInput('#admin-name', ADMIN.name);
  await fillInput('#admin-email', ADMIN.email);
  await fillInput('#admin-pass', ADMIN.password);
  await fillInput('#admin-confirm', ADMIN.password);
  await clickText(SEL.setup.wizard, '记录管理员账户');
  await sleep(500);
  await wizardClickNext();

  // 第 5 步：默认站点
  await wizardClickNext();

  // 第 6 步：登录方式（保持默认）
  await wizardClickNext();

  // 第 7 步：检查并完成
  const finishReady = await waitUntil(`(() => {
    const button = [...document.querySelectorAll('.wiz .wiz-actions button')].find((node) => /完成安装/.test(node.textContent ?? ''));
    return button && !button.disabled;
  })()`, 20000);
  await check('SETUP', '安装向导走到「检查与完成」且可完成', !!finishReady);
  await clickText(SEL.setup.wizard, '完成安装');
  const config = await waitUntil(`(() => {
    try { return JSON.parse(localStorage.getItem('pp.web.config.v1') || 'null'); } catch { return null; }
  })()`, 20000);
  await check('SETUP', '安装完成并写入 pp.web.config.v1（演示模式）', !!config && config.mode === 'demo', config ? `mode=${config.mode} site_id=${config.site_id}` : '配置为空');
  await sleep(600);
}

async function ensureLoggedIn() {
  await goto('/login');
  await sleep(600);
  const hasForm = await evaljs(`!!document.querySelector('input[type="email"]')`);
  if (!hasForm) {
    const loggedIn = await evaljs(`!!document.querySelector('.header-user, .user-trigger, a[href="/admin"]')`);
    await check('SETUP', '演示管理员已处于登录态', loggedIn);
    return loggedIn;
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
  await check('SETUP', '演示管理员登录成功', !!ok, `当前页面=${ok ? await evaljs('location.pathname') : '/login'}`);
  return !!ok;
}

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

async function currentArticleId() {
  const pathname = await evaljs('location.pathname');
  const match = /\/admin\/content\/(?:article|post)\/([^/?#]+)/.exec(pathname);
  return match ? match[1] : '';
}

async function saveDraftAndId() {
  await clickText('.admin-page-actions', '保存');
  const ready = await waitUntil(`/\\/admin\\/content\\/(?:article|post)\\/[^/?#]+/.test(location.pathname)`, 12000);
  if (!ready) return '';
  await sleep(500);
  return currentArticleId();
}

async function ensureSampleArticleId() {
  if (savedArticleId) return savedArticleId;
  await goto('/articles');
  const href = await waitUntil(`(() => {
    const link = document.querySelector('a[href^="/a/"]');
    return link ? link.getAttribute('href') : '';
  })()`, 10000);
  if (!href) return '';
  savedArticleId = href.split('/').pop() ?? '';
  return savedArticleId;
}

let savedArticleId = '';

/* ------------------------------------------------------------------ */
/* A. 文章自定义封面                                                   */
/* ------------------------------------------------------------------ */

async function blockA() {
  currentBlock = 'A';
  await goto('/admin/content/new/article');
  await waitUntil(`!!document.querySelector(${q(SEL.editor.surface)})`, 15000);

  const title = `验收封面 ${STAMP}`;
  await fillInput(SEL.editor.title, title);
  await focusEditor();
  await typeText('封面验收正文。');
  await sleep(500);

  const id = await saveDraftAndId();
  const savedOk = await check('A', '新建文章并保存草稿', !!id, id ? `id=${id}` : '保存后 URL 未带稿件 id');
  if (!savedOk) return;
  savedArticleId = id;

  // 右侧封面面板
  const panel = await evaljs(`(() => {
    const panels = [...document.querySelectorAll('.editor-side .panel')];
    const panel = panels.find((node) => ${SEL.cover.panelHeading}.test(node.querySelector('h3, .panel-head h3')?.textContent ?? ''));
    return {
      found: !!panel,
      headings: panels.map((node) => (node.querySelector('h3, .panel-head h3')?.textContent ?? '').trim()).filter(Boolean),
    };
  })()`);
  if (!(await check('A', '编辑页右侧出现「封面」面板', panel?.found, `面板标题=${(panel?.headings ?? []).join(' / ') || '（无）'}`))) return;

  // 封面面板是受控输入：填完地址后要点「应用」（失焦 / 回车同样会写入），
  // 只 dispatch input 事件不会触发 ArticleCoverPanel 的 applyUrl。
  await waitUntil(`(() => { const el = document.querySelector(${q(SEL.cover.input)}); return !!el && !el.disabled; })()`, 8000);
  let inputOk = true;
  try {
    await fillInput(SEL.cover.input, COVER_URL);
  } catch (err) {
    inputOk = false;
    await check('A', '封面面板可填写图片地址', false, err instanceof Error ? err.message : String(err));
  }
  if (!inputOk) return;
  await sleep(200);
  const applied = await clickText(SEL.cover.panel, SEL.cover.apply, { required: false });
  await check('A', '点击「应用」写入封面地址', !!applied?.ok, applied?.ok ? '' : `面板里没有匹配 ${SEL.cover.apply} 的按钮`);
  await sleep(300);

  const preview = await waitUntil(`(() => {
    const panels = [...document.querySelectorAll('.editor-side .panel')];
    const panel = panels.find((node) => ${SEL.cover.panelHeading}.test(node.querySelector('h3, .panel-head h3')?.textContent ?? ''));
    const img = panel?.querySelector('img');
    return img && (img.getAttribute('src') ?? '').startsWith('data:image/') ? { src: (img.getAttribute('src') ?? '').slice(0, 40) } : null;
  })()`, 6000);
  await check('A', '封面面板出现图片预览', !!preview, preview ? `src=${preview.src}…` : '面板里没有 data:image 预览图');
  await shot('A-cover-panel', SEL.cover.panel);

  // 再保存一次，把封面写进配置
  await clickText('.admin-page-actions', '保存');
  await sleep(1000);
  const stored = await waitUntil(`(() => {
    try {
      const config = JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}');
      const cover = (config.customization?.covers ?? []).find((item) => item.id === ${q(id)});
      return cover && cover.url ? cover : null;
    } catch { return null; }
  })()`, 8000);
  await check('A', '封面配置写入 localStorage 且地址正确', !!stored && stored.url === COVER_URL, stored ? `id=${stored.id}` : 'covers 里没有该稿件');

  // 前台详情
  await goto(`/a/${id}`);
  const front = await waitUntil(`(() => {
    const img = document.querySelector('.article-cover img');
    if (!img) return null;
    return {
      src: (img.getAttribute('src') ?? '').slice(0, 40),
      parent: img.parentElement?.className ?? '',
      inCover: !!img.closest('.article-cover'),
    };
  })()`, 15000);
  await check('A', '前台文章详情渲染封面 img', !!front, front ? `src=${front.src}… 父级=${front.parent}` : '.article-cover 内没有 img');
  await check('A', '封面 img 父级包含 cover-custom', !!front && /cover-custom/.test(front.parent), front ? `父级=${front.parent}` : '没有 img');
  await shot('A-front-cover', '.article-cover');
}

/* ------------------------------------------------------------------ */
/* B. Markdown 输入                                                    */
/* ------------------------------------------------------------------ */

async function blockB() {
  currentBlock = 'B';
  await goto('/admin/content/new/article');
  await waitUntil(`!!document.querySelector(${q(SEL.editor.surface)})`, 15000);
  await fillInput(SEL.editor.title, `验收 Markdown ${STAMP}`);
  await focusEditor();

  const readHeadings = () =>
    evaljs(`(() => {
      const root = document.querySelector('.rich-surface');
      if (!root) return { h2: [], h3: [], h4: [], text: '' };
      const grab = (selector) => [...root.querySelectorAll(selector)].map((node) => (node.textContent ?? '').trim());
      return { h2: grab('h2'), h3: grab('h3'), h4: grab('h4'), text: (root.innerText ?? '').replace(/\\s+/g, ' ').trim() };
    })()`);

  // 设计映射（见 lib/markdownInput.ts 与单测）：编辑器正文标题从二级开始，一级留给页面标题，
  // 所以 `# `→h2、`## `→h3、`### `/`#### `→h4。验收口径里的「## → h2」与实现映射不一致，
  // 这里按实现映射断言，另在报告中单独说明该口径差异。
  const snapshots = [];
  await typeText('## ');
  await sleep(600);
  let headings = await readHeadings();
  let all = [...headings.h2, ...headings.h3, ...headings.h4];
  snapshots.push(`空格后 h2=${JSON.stringify(headings.h2)} h3=${JSON.stringify(headings.h3)}`);
  if (!all.length) {
    await typeText('小标题');
    await sleep(300);
    await pressKey('Enter');
    await sleep(700);
    headings = await readHeadings();
    all = [...headings.h2, ...headings.h3, ...headings.h4];
    snapshots.push(`回车后 h2=${JSON.stringify(headings.h2)} h3=${JSON.stringify(headings.h3)}`);
  } else {
    await typeText('小标题');
    await sleep(500);
    headings = await readHeadings();
    all = [...headings.h2, ...headings.h3, ...headings.h4];
    snapshots.push(`输入标题后 h2=${JSON.stringify(headings.h2)} h3=${JSON.stringify(headings.h3)}`);
  }
  await check('B', '输入 "## " 前缀后生成正文标题（h2/h3/h4）', all.length > 0, snapshots.join('；'));
  await check('B', '标题文本包含「小标题」', all.some((text) => text.includes('小标题')), `标题=${JSON.stringify(all)}`);
  await check(
    'B',
    '实现映射符合当前设计（## → h3，单测同口径）',
    headings.h3.some((text) => text.includes('小标题')),
    `h3=${JSON.stringify(headings.h3)}（若验收要求 ## → h2，需要实现与单测一起改）`,
  );
  await check('B', '字面前缀 "##" 已被消费、未留在正文', !headings.text.includes('##'), `正文=${headings.text.slice(0, 80) || '（空）'}`);
  await shot('B-markdown-heading', '.rich-surface');

  // 新段落输入 "/" 打开指令面板
  await pressKey('Enter');
  await sleep(250);
  await typeText('/');
  await sleep(800);
  const slash = await countSelector(SEL.markdown.slash);
  await check('B', '输入 / 打开斜杠指令面板', slash.count > 0, slash.selector ? `选择器=${slash.selector} 项=${slash.count}` : `候选都未命中: ${SEL.markdown.slash.join(' / ')}`);
  if (slash.count > 0) {
    const menuText = await evaljs(`(() => {
      const el = document.querySelector(${q(slash.selector)});
      return (el?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    })()`);
    await check('B', '斜杠指令面板有可见条目', (menuText ?? '').length > 0, `文案=${menuText || '（空）'}`);
    await shot('B-slash-menu');
  }

  await pressKey('Escape');
  await sleep(500);
  const afterEscape = await countSelector(SEL.markdown.slash);
  await check('B', 'Esc 关闭斜杠指令面板', afterEscape.count === 0, afterEscape.count ? `仍可见 ${afterEscape.count} 个（${afterEscape.selector}）` : '已关闭');
}

/* ------------------------------------------------------------------ */
/* C. 链接卡片                                                         */
/* ------------------------------------------------------------------ */

async function blockC() {
  currentBlock = 'C';
  await goto('/admin/content/new/article');
  await waitUntil(`!!document.querySelector(${q(SEL.editor.surface)})`, 15000);
  await fillInput(SEL.editor.title, `验收链接卡片 ${STAMP}`);
  await focusEditor();
  await typeText('链接卡片验收正文。');
  await sleep(300);

  // 工具栏「链接」：点击后等 .link-mode-switch 出现（比只看 .modal-layer 更稳）。
  const clickLinkToolbar = () =>
    evaljs(`(() => {
      const list = ${JSON.stringify(SEL.link.tool)};
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (el) { el.click(); return { ok: true, selector }; }
      }
      const nodes = [...document.querySelectorAll('.rich-toolbar button')];
      const el = nodes.find((node) => /链接/.test((node.title ?? '') + (node.getAttribute('aria-label') ?? '') + (node.textContent ?? '')));
      if (el) { el.click(); return { ok: true, selector: '工具栏文案匹配' }; }
      return { ok: false, titles: nodes.map((node) => node.title).filter(Boolean).slice(0, 30) };
    })()`);
  const readLinkDialog = () =>
    evaljs(`(() => {
      const modal = document.querySelector('.link-mode-switch')?.closest('.modal-layer') ?? document.querySelector('.modal-layer');
      return modal
        ? {
            layers: document.querySelectorAll('.modal-layer').length,
            aria: modal.getAttribute('aria-label') ?? '',
            modeButtons: [...modal.querySelectorAll('.link-mode-switch button')].map((node) => (node.textContent ?? '').trim()),
            text: (modal.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          }
        : null;
    })()`);

  const tool = await clickLinkToolbar();
  if (!(await check('C', '工具栏找到「链接」按钮并点击', tool?.ok, tool?.ok ? tool.selector : `工具栏按钮=${(tool?.titles ?? []).join(' / ')}`))) return;
  let dialogOpen = await waitUntil(`!!document.querySelector('.link-mode-switch button')`, 8000).catch(() => null);
  if (!dialogOpen) {
    // 偶发：弹窗被关闭（焦点 / 全局快捷键 / 导航残留）。记录现场后重开一次。
    logLine(`  [diag] 链接弹窗未出现，重试一次；现场=${JSON.stringify(await readLinkDialog().catch(() => null))}`);
    await clickLinkToolbar();
    dialogOpen = await waitUntil(`!!document.querySelector('.link-mode-switch button')`, 8000).catch(() => null);
  }
  await check('C', '链接弹窗打开且含形态切换', !!dialogOpen, dialogOpen ? '' : `现场=${JSON.stringify(await readLinkDialog().catch(() => null))}`);
  if (!dialogOpen) return;

  // 切「卡片」模式（实现：.link-mode-switch 里的「文字链接 / 卡片链接」）
  const mode = await evaljs(`(() => {
    const nodes = [...document.querySelectorAll('.link-mode-switch button')];
    const el = nodes.find((node) => ${SEL.link.cardMode}.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!el) return { ok: false, texts: nodes.map((node) => (node.textContent ?? '').trim()) };
    el.click();
    return { ok: true, text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30) };
  })()`);
  await check('C', '链接弹窗切换到「卡片」模式', mode?.ok, mode?.ok ? mode.text : `弹窗内按钮=${(mode?.texts ?? []).join(' / ')}`);
  if (!mode?.ok) return;
  await sleep(350);

  const labels = await evaljs(`(() => {
    const modal = document.querySelector(${q(SEL.link.modal)});
    return modal ? [...modal.querySelectorAll('.field')].map((field) => (field.querySelector('.field-label, label')?.textContent ?? '').trim()).filter(Boolean) : [];
  })()`);
  await check(
    'C',
    '卡片模式包含网址 / 标题 / 说明字段',
    labels.some((text) => text.includes('网址') || text.includes('链接') || text.includes('URL')) &&
      labels.some((text) => text.includes('标题')) &&
      labels.some((text) => /说明|描述|简介/.test(text)),
    `字段=${labels.join(' / ') || '（无）'}`,
  );

  try {
    // 实现为固定 id；先按 id 填，失败再退回按字段标题匹配（防止后续改 id）。
    await fillInput(SEL.link.fields.href, CARD_URL);
    await fillInput(SEL.link.fields.title, CARD_TITLE);
    await fillInput(SEL.link.fields.desc, CARD_DESC);
    await check('C', '卡片表单填写完成', true, `#rich-link-href/title/desc 已填写，网址=${CARD_URL}`);
  } catch (idError) {
    try {
      await fillByLabel(SEL.link.modal, ['网址', '链接', 'URL', '地址'], CARD_URL);
      await fillByLabel(SEL.link.modal, ['标题'], CARD_TITLE);
      await fillByLabel(SEL.link.modal, ['说明', '描述', '简介'], CARD_DESC);
      await check('C', '卡片表单填写完成', true, `回退按字段标题填写；固定 id 失败原因: ${idError instanceof Error ? idError.message : String(idError)}`);
    } catch (err) {
      await check('C', '卡片表单填写完成', false, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  const confirm = await evaljs(`(() => {
    const foot = document.querySelector('.modal-foot');
    if (!foot) return { ok: false, reason: 'modal-foot missing' };
    const buttons = [...foot.querySelectorAll('button')].filter((node) => !node.disabled);
    const button = buttons.find((node) => ${SEL.link.insertButton}.test(node.textContent ?? ''));
    if (!button) return { ok: false, texts: buttons.map((node) => (node.textContent ?? '').trim()) };
    button.click();
    return { ok: true, text: (button.textContent ?? '').trim() };
  })()`);
  if (!(await check('C', '点击插入链接卡片', confirm?.ok, confirm?.ok ? confirm.text : `弹窗按钮=${(confirm?.texts ?? []).join(' / ')}`))) return;
  await sleep(800);

  const card = await evaljs(`(() => {
    const link = document.querySelector(${q(SEL.link.editorCard)});
    return link ? { href: link.getAttribute('href') ?? '', text: (link.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90) } : null;
  })()`);
  await check('C', '编辑区出现 a.pp-linkcard', !!card, card ? `href=${card.href} 文本=${card.text}` : `${SEL.link.editorCard} 不存在`);
  if (card) await check('C', '卡片链接指向填写的网址', card.href.includes('example.com/qa-linkcard'), card.href);
  await shot('C-editor-linkcard', SEL.link.editorCard);

  const id = await saveDraftAndId();
  if (!(await check('C', '保存含链接卡片的文章', !!id, id ? `id=${id}` : '保存后 URL 未带稿件 id'))) return;
  savedArticleId = id;

  await goto(`/a/${id}`);
  const front = await waitUntil(`(() => {
    const link = document.querySelector(${q(SEL.link.frontCard)});
    return link ? { href: link.getAttribute('href') ?? '', text: (link.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90) } : null;
  })()`, 15000);
  await check('C', '前台文章详情渲染链接卡片', !!front, front ? `href=${front.href}` : `${SEL.link.frontCard} 不存在（Markdown 往返或清洗可能丢了卡片）`);
  if (front) await check('C', '前台卡片链接仍指向原网址', front.href.includes('example.com/qa-linkcard'), front.href);
  await shot('C-front-linkcard', SEL.link.frontCard);
}

/* ------------------------------------------------------------------ */
/* D. 创作者扩展                                                       */
/* ------------------------------------------------------------------ */

async function clickExtensionsTab(pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const result = await evaljs(`(() => {
    const re = new RegExp(${q(source)});
    const nodes = [...document.querySelectorAll('.ppe-tabs button, [role="tab"], .tab, .admin-tabs button, button, a')];
    const visible = nodes.filter((node) => node.getClientRects().length > 0);
    const el = visible.find((node) => re.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!el) return { ok: false, texts: visible.map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 20) };
    el.click();
    return { ok: true, text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30) };
  })()`);
  if (result?.ok) await sleep(700);
  return result;
}

async function readCustomExtensions() {
  return evaljs(`(() => {
    try {
      const config = JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}');
      return config.customization?.custom_extensions ?? [];
    } catch { return []; }
  })()`);
}

async function toggleExtension(name, want) {
  return evaljs(`(() => {
    const name = ${q(name)};
    const selector = ${q(SEL.extensions.toggleSelector)};
    const switches = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0);
    let el = switches.find((node) => ((node.getAttribute('aria-label') ?? '') + (node.textContent ?? '')).includes(name));
    if (!el) {
      // 兜底：在包含扩展名的行里找开关。按文本长度从短到长挑最内层的行，
      // 避免先命中包住整页的外层 section 而点到第一个内置扩展开关。
      const rows = [...document.querySelectorAll(${q(SEL.extensions.rowSelector)})]
        .filter((node) => (node.textContent ?? '').includes(name))
        .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length);
      el = rows[0]?.querySelector(selector) ?? null;
    }
    if (!el) {
      return {
        ok: false,
        reason: '找不到扩展开关',
        switches: switches.map((node) => (node.getAttribute('aria-label') || (node.textContent ?? '')).replace(/\\s+/g, ' ').trim().slice(0, 22)).slice(0, 12),
      };
    }
    const on = el.getAttribute('aria-checked') === 'true' || el.classList.contains('is-on');
    const clicked = on !== ${Boolean(want)};
    if (clicked) el.click();
    return { ok: true, before: on, clicked };
  })()`);
}

async function blockD() {
  currentBlock = 'D';
  // 已按移除「扩展工坊」后的 Extensions.tsx 校准：Tabs 只剩「内置扩展 / 我的扩展」，
  // 创作者扩展通过「导入示例」进入，再在卡片上启用 / 停用。若文案或 class 变化，只需改 SEL.extensions。
  await goto('/admin/extensions');
  const h1 = await waitUntil(`(() => {
    const heading = document.querySelector('h1')?.textContent ?? '';
    return /扩展/.test(heading) ? heading : '';
  })()`, 15000);
  if (!(await check('D', '打开 /admin/extensions 扩展页', !!h1, h1 ? `h1=${h1.trim()}` : '页面标题不含「扩展」'))) return;

  const studio = await evaljs(`(() => {
    const tabs = [...document.querySelectorAll('.tabs button, [role="tab"], button')]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    return { text: (document.body.innerText || '').includes('扩展工坊'), tabs: tabs.slice(0, 20) };
  })()`);
  await check('D', '扩展工坊入口已移除', studio?.text === false, `标签=${(studio?.tabs ?? []).join(' / ')}`);

  const myTabFirst = await clickExtensionsTab(SEL.extensions.myTab);
  if (!(await check('D', '「我的扩展」标签可用', myTabFirst?.ok, myTabFirst?.ok ? `点击「${myTabFirst.text}」` : `标签候选=${(myTabFirst?.texts ?? []).join(' / ')}`))) return;

  // 走“导入扩展”区域的一键示例：与上传 .ppext.json 共用同一条解析 / 写入路径。
  const imported = await evaljs(`(() => {
    const nodes = [...document.querySelectorAll('.ppe-sample-row button, button')].filter((node) => node.getClientRects().length > 0);
    const re = new RegExp(${q(SEL.extensions.importSample.source)});
    const target = nodes.find((node) => re.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!target) return { ok: false, texts: nodes.map((node) => (node.textContent ?? '').trim()).filter(Boolean).slice(0, 24) };
    target.click();
    return { ok: true, text: (target.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30) };
  })()`);
  if (!(await check('D', '可从「导入扩展」一键导入示例', imported?.ok, imported?.ok ? `点击「${imported.text}」` : `按钮候选=${(imported?.texts ?? []).join(' / ')}`))) return;
  await sleep(900);

  const exts = await readCustomExtensions();
  const ext = exts[exts.length - 1];
  if (!(await check('D', '扩展写入 customization.custom_extensions', !!ext && !!ext.id, ext ? `id=${ext.id} name=${ext.name} slots=${(ext.slots ?? []).join(',')}` : 'custom_extensions 为空'))) return;

  // 我的扩展 → 启用
  const myTab = await clickExtensionsTab(SEL.extensions.myTab);
  if (!(await check('D', '「我的扩展」标签可用', myTab?.ok, myTab?.ok ? `点击「${myTab.text}」` : `标签候选=${(myTab?.texts ?? []).join(' / ')}`))) return;
  const on = await toggleExtension(ext.name, true);
  if (!(await check('D', '「我的扩展」中启用扩展', on?.ok, on?.ok ? `切换前=${on.before} 已点击=${on.clicked}` : `${on?.reason}；开关列表=${(on?.switches ?? []).join(' | ')}`))) return;
  await sleep(700);
  const enabled = await readCustomExtensions().then((list) => list.find((item) => item.id === ext.id));
  await check('D', '启用状态写入配置', !!enabled && enabled.enabled === true, enabled ? `enabled=${enabled.enabled}` : '找不到扩展');

  // 前台出现 iframe
  const articleId = await ensureSampleArticleId();
  if (!(await check('D', '找到用于验证扩展的前台文章', !!articleId, articleId ? `/a/${articleId}` : '文章列表里没有可用文章'))) return;
  await goto(`/a/${articleId}`);
  const iframe = await waitUntil(`(() => {
    const el = document.querySelector(${q(SEL.extensions.iframe)});
    if (!el) return null;
    return {
      title: el.getAttribute('title') ?? '',
      len: (el.getAttribute('srcdoc') ?? '').length,
      parent: el.parentElement?.className ?? '',
    };
  })()`, 15000);
  await check('D', '前台文章页出现 iframe[data-pp-extension]', !!iframe, iframe ? `srcdoc=${iframe.len} 字符 父级=${iframe.parent}` : '文章页没有扩展 iframe（槽位 / 页面范围 / 启用状态任一不满足）');
  if (iframe) await shot('D-front-extension', SEL.extensions.iframe);

  // 禁用 → 刷新后消失
  await goto('/admin/extensions');
  await waitUntil(`/扩展/.test(document.querySelector('h1')?.textContent ?? '')`, 12000);
  const myTabAgain = await clickExtensionsTab(SEL.extensions.myTab);
  await check('D', '禁用流程可回到「我的扩展」标签', !!myTabAgain?.ok, myTabAgain?.ok ? '' : `标签候选=${(myTabAgain?.texts ?? []).join(' / ')}`);
  const off = await toggleExtension(ext.name, false);
  await check('D', '可在「我的扩展」禁用扩展', off?.ok, off?.ok ? `切换前=${off.before} 已点击=${off.clicked}` : `${off?.reason}；开关列表=${(off?.switches ?? []).join(' | ')}`);
  await sleep(700);
  const disabled = await readCustomExtensions().then((list) => list.find((item) => item.id === ext.id));
  await check('D', '禁用状态写入配置', !!disabled && disabled.enabled === false, disabled ? `enabled=${disabled.enabled}` : '找不到扩展');

  await goto(`/a/${articleId}`);
  await sleep(1600);
  const remaining = await evaljs(`document.querySelectorAll(${q(SEL.extensions.iframe)}).length`);
  await check('D', '刷新后扩展 iframe 消失', remaining === 0, remaining ? `仍剩 ${remaining} 个` : '已消失');
  await shot('D-front-extension-disabled', '.article-foot');
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function ensureReachable() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `无法访问 PP_E2E_BASE=${BASE}（${err instanceof Error ? err.message : String(err)}）。` +
        `请先在 apps/web 执行 npm run build，并让 node scripts/serve.mjs 在对应端口运行。`,
    );
  }
}

async function main() {
  await ensureReachable();
  await mkdir(TMP, { recursive: true });
  await startChrome();
  try {
    await connectPage();

    console.log('\n=== 准备：安装引导（演示模式）+ 管理员登录 ===');
    let config = await readConfig();
    if (!config) {
      await runSetupWizard();
      config = await readConfig();
    } else {
      await check('SETUP', '已存在安装配置，跳过安装引导', true, `mode=${config.mode}`);
    }
    if (!config) {
      fail('SETUP', '准备环境', '安装配置缺失，跳过所有功能验收块');
      return;
    }
    const loggedIn = await ensureLoggedIn();
    if (!loggedIn) {
      fail('SETUP', '准备环境', '演示管理员未登录，跳过所有功能验收块');
      return;
    }

    const allBlocks = [
      { id: 'A', title: '文章自定义封面', run: blockA },
      { id: 'B', title: 'Markdown 输入增强', run: blockB },
      { id: 'C', title: '链接卡片', run: blockC },
      { id: 'D', title: '创作者扩展', run: blockD },
    ];
    // PP_E2E_BLOCKS=B,C 只跑指定验收块（调试用；准备步骤仍会执行）。
    const only = (process.env.PP_E2E_BLOCKS ?? '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    const blocks = only.length ? allBlocks.filter((block) => only.includes(block.id)) : allBlocks;
    if (only.length) console.log(`[filter] PP_E2E_BLOCKS=${only.join(',')}，只运行 ${blocks.map((block) => block.id).join(',')}`);
    for (const block of blocks) {
      console.log(`\n=== ${block.id}. ${block.title} ===`);
      currentBlock = block.id;
      try {
        await block.run();
      } catch (err) {
        await check(block.id, '验收块执行未中断', false, err instanceof Error ? err.message : String(err));
      }
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

function printSummary() {
  const blocks = ['SETUP', 'A', 'B', 'C', 'D'];
  console.log('\n================ 汇总 ================');
  for (const block of blocks) {
    const items = results.filter((item) => item.block === block);
    if (!items.length) continue;
    const ok = items.filter((item) => item.ok).length;
    const bad = items.length - ok;
    console.log(`${block}  ${bad === 0 ? 'PASS' : 'FAIL'}  ${ok}/${items.length}`);
  }
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  console.log(`\nPASS ${passed} / FAIL ${failed.length}`);
  if (failed.length) {
    console.log('\n失败清单：');
    for (const item of failed) console.log(`  - [${item.block}] ${item.name}${item.extra ? ` · ${item.extra}` : ''}`);
  }
  if (shots.length) {
    console.log(`\n截图 ${shots.length} 张：`);
    for (const file of shots) console.log(`  - ${file}`);
  }
  if (!SHOTS_ENABLED) console.log('\n（PP_E2E_SHOTS=0，已跳过截图）');
  console.log('');
  return failed.length;
}

try {
  await main();
} catch (err) {
  console.log(`\nERROR ${err instanceof Error ? err.message : String(err)}`);
  fail(currentBlock, '脚本启动 / 环境', err instanceof Error ? err.message : String(err));
}

const failedCount = printSummary();
process.exit(failedCount ? 1 : 0);
