#!/usr/bin/env node
/**
 * 中英双语的端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 覆盖：
 * 1. 全新安装：引导默认简体中文；
 * 2. 引导右上角切到 English：`<html lang>`、主导文案与整页中文一起切换；
 * 3. 切回简体中文：完全复原（中文零回归）；
 * 4. 后台「站点设置」不再提供语言切换：站点语言只在安装引导里决定；
 * 5. 站点语言为 English 时后台整页英文（侧边栏与页头零中文）；
 * 6. 站点语言回到简体中文时后台复原（中文零回归）。
 *
 * 前置：cd web && npm run build && node scripts/serve.mjs --port 8099
 * 运行：cd web && node scripts/e2e-i18n.mjs
 * 环境变量：CHROME_PATH / PP_E2E_BASE / PP_E2E_PORT（默认 9360）
 * 输出：web/.tmp/shots-i18n/ 截图 + PASS/FAIL 汇总。
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
if (!CHROME) {
  console.error('找不到 Chrome / Edge；用 CHROME_PATH 指定可执行文件。');
  process.exit(1);
}

const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const PORT = Number(process.env.PP_E2E_PORT ?? 9360);
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS = path.join(TMP, 'shots-i18n');
await mkdir(SHOTS, { recursive: true });
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-i18n-${process.pid}/`, import.meta.url));

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
    } catch {
      /* 还没起来 */
    }
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

async function goto(url, wait = 1200) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  · ${detail}` : ''}`);
}

/** `<html lang>`。 */
const LANG = 'document.documentElement.lang';

/** 某个容器（默认整页）里的中文数量：英文界面下应当接近 0。 */
const CJK = (selector = 'body') => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)}) ?? document.body;
  const text = (node.innerText || '').replace(/\\s+/g, '');
  return (text.match(/[\\u4e00-\\u9fff]/g) ?? []).length;
})()`;

/** 页面里是否有某段文字（用于确认「原文还在」或「已经换掉」）。 */
const HAS_TEXT = (text, selector = 'body') => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)}) ?? document.body;
  return (node.innerText || '').includes(${JSON.stringify(text)});
})()`;

/** 点击包含指定文字的第一个可点击元素。 */
const CLICK_TEXT = (text, selector = 'button, label, a') => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const hit = nodes.find((n) => (n.innerText || '').trim().includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.click();
  return true;
})()`;

/** 演示站点配置：与 e2e-header 保持同一形状，额外带上站点语言。 */
function config(language) {
  return {
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
      language,
      theme: { preset: 'paper', mode: 'light' },
      layout: {
        variant: 'classic',
        header_style: 'classic',
        header_blur: true,
        header_blur_amount: 12,
        header_threshold: 8,
      },
    },
  };
}

/**
 * 写一份演示站点配置。
 *
 * 演示后端把「当前登录账户」也放在 localStorage（`pp.demo.current.v1`）：
 * 不写它，访问 /admin/* 会被送去登录页。`usr_admin` 是演示数据里的最高管理员。
 */
async function seedConfig(language) {
  await evaljs(
    `localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(config(language)))});
     localStorage.setItem('pp.demo.current.v1', 'usr_admin');
     true`,
  );
}

try {
  await send('Page.enable');
  await send('Runtime.enable');

  /* ---------- 1. 全新安装：默认简体中文 ---------- */
  await goto(BASE + '/');
  await evaljs(`localStorage.clear(); sessionStorage.clear(); true`);
  await goto(BASE + '/', 1600);

  const bootLang = await evaljs(LANG);
  check('全新安装默认简体中文', bootLang === 'zh-CN', `lang=${bootLang}`);

  const zhHeadline = await evaljs(HAS_TEXT('先给这间编辑部', '.wiz-welcome h1'));
  check('引导首屏是中文文案', zhHeadline === true);
  const zhCjk = await evaljs(CJK('.wiz-welcome'));
  check('中文引导里有中文', zhCjk > 10, `${zhCjk} 字`);
  await shot('setup-zh');

  /* ---------- 2. 引导里切到 English ---------- */
  const clickedEn = await evaljs(CLICK_TEXT('English', '.wiz-lang-btn'));
  check('引导右上角有 English 切换按钮', clickedEn === true);
  await sleep(700);

  const enLang = await evaljs(LANG);
  check('切到 English 后 <html lang> 变为 en', enLang === 'en', `lang=${enLang}`);
  const enHeadlineGone = await evaljs(HAS_TEXT('先给这间编辑部', '.wiz-welcome h1'));
  check('英文界面下中文标题消失', enHeadlineGone === false);
  const enCjk = await evaljs(CJK('.wiz-welcome'));
  check('英文引导里没有残留中文', enCjk === 0, `残留 ${enCjk} 字`);
  await shot('setup-en');

  /* ---------- 3. 切回简体中文：中文零回归 ---------- */
  const clickedZh = await evaljs(CLICK_TEXT('简体中文', '.wiz-lang-btn'));
  check('可以切回简体中文', clickedZh === true);
  await sleep(700);
  const backLang = await evaljs(LANG);
  const backZh = await evaljs(HAS_TEXT('先给这间编辑部', '.wiz-welcome h1'));
  check('切回中文后 <html lang> 复原', backLang === 'zh-CN', `lang=${backLang}`);
  check('切回中文后文案逐字复原', backZh === true);

  /* ---------- 4. 后台「站点设置」不再有语言切换 ---------- */
  await seedConfig('zh-CN');
  await goto(BASE + '/admin/settings', 2200);

  const adminZhLang = await evaljs(LANG);
  check('演示站点后台默认中文', adminZhLang === 'zh-CN', `lang=${adminZhLang}`);
  const navZh = await evaljs(CJK('.admin-nav'));
  check('中文后台侧边栏是中文', navZh > 5, `${navZh} 字`);
  const hasLangPanel = await evaljs(HAS_TEXT('站点语言', '.editor-main'));
  check('后台设置里已经没有站点语言面板', hasLangPanel === false);

  /* ---------- 5. 站点语言为 English 时后台整页英文 ---------- */
  await seedConfig('en');
  await goto(BASE + '/admin/settings', 2200);

  const adminEnLang = await evaljs(LANG);
  check('站点语言是 English 时后台整页英文', adminEnLang === 'en', `lang=${adminEnLang}`);
  const navEn = await evaljs(CJK('.admin-nav'));
  check('英文后台侧边栏没有中文', navEn === 0, `残留 ${navEn} 字`);
  const pageEn = await evaljs(CJK('.admin-page-head'));
  check('英文后台页头没有中文', pageEn === 0, `残留 ${pageEn} 字`);
  await shot('admin-en');

  /* ---------- 6. 回到简体中文：后台复原 ---------- */
  await seedConfig('zh-CN');
  await goto(BASE + '/admin/settings', 2200);
  const finalLang = await evaljs(LANG);
  const finalNav = await evaljs(CJK('.admin-nav'));
  check('切回中文后 <html lang> 复原', finalLang === 'zh-CN', `lang=${finalLang}`);
  check('切回中文后侧边栏恢复中文', finalNav > 5, `${finalNav} 字`);
  await shot('admin-zh');

  /* ---------- 7. 前台站点在英文下的页头 ---------- */
  await seedConfig('en');
  await goto(BASE + '/', 2000);
  const siteLang = await evaljs(LANG);
  check('前台也跟随站点语言', siteLang === 'en', `lang=${siteLang}`);
  await shot('site-en');
} catch (err) {
  console.error('运行失败：', err);
  results.push({ name: '脚本异常', ok: false, detail: String(err) });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log('─'.repeat(64));
  console.log(`PASS ${results.length - failed.length} / FAIL ${failed.length}`);
  console.log(`截图：${SHOTS}`);
  try {
    proc.kill();
  } catch {
    /* 已经退出 */
  }
  process.exit(failed.length ? 1 : 0);
}
