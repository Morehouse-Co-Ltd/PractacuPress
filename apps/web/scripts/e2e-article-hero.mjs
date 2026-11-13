/**
 * 文章页「封面式页头」端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 覆盖：
 * - 有自定义封面时：全宽封面头 + 标题压在图上 + 正文顶部的模糊底图；
 * - 顶部透明页头：封面伸到页头后面，滚动前页头文字为白色，滚动后回到主题色；
 * - 作者隐藏封面：退回原来的 .article-head，不渲染封面；
 * - 没有自定义封面：铺程序化底纹，标题照旧压在上面，不铺模糊底图；
 * - 后台「站点设置 → 发布模式」三张卡排在同一行；
 * - 后台媒体库（演示数据）缩略图能显示。
 *
 * 前置：`cd apps/web && npm run dev`（默认 5173），或用 serve.mjs 托管构建产物。
 * 运行：`cd apps/web && node scripts/e2e-article-hero.mjs`
 * 环境变量：CHROME_PATH / PP_E2E_BASE（默认 http://127.0.0.1:5173）/ PP_E2E_PORT（默认 9412）。
 * 输出：`apps/web/.tmp/shots-article-hero/` 截图 + 终端 PASS/FAIL 汇总。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
  .filter(Boolean)
  .find((candidate) => existsSync(candidate));
const BASE = (process.env.PP_E2E_BASE ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const PORT = Number(process.env.PP_E2E_PORT ?? 9412);
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS = path.join(TMP, 'shots-article-hero');
const PROFILE = path.join(TMP, `chrome-article-hero-${process.pid}`);
await mkdir(SHOTS, { recursive: true });

// 演示数据里固定的一篇已发布文章；封面图用内联 SVG，不依赖 public/ 里的临时文件。
const ARTICLE_ID = 'cnt_house';
const COVER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1">` +
  `<stop offset="0" stop-color="#1d2436"/><stop offset="0.55" stop-color="#5d4460"/><stop offset="1" stop-color="#c9906b"/>` +
  `</linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/>` +
  `<circle cx="1200" cy="240" r="220" fill="rgba(255,255,255,0.16)"/></svg>`;
const COVER_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(COVER_SVG)}`;

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
    '--window-size=1440,1000',
    BASE,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) return res.json();
    } catch {
      /* devtools 还没起来，继续等 */
    }
    await sleep(250);
  }
  throw new Error('devtools 未就绪');
}

const targets = await waitDevtools();
const page = targets.find((target) => target.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('WebSocket 连接失败'));
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
  if (message.id != null && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
};

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaljs(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`页面脚本异常: ${String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 400)}`);
  }
  return result.result.value;
}

async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1600);
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(result.data, 'base64'));
}

async function waitFor(selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evaljs(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(200);
  }
  return false;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  · ${detail}` : ''}`);
}

function config({ layout = {}, covers = [], theme = { preset: 'paper', mode: 'light' } } = {}) {
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
      theme,
      layout: {
        variant: theme.mode === 'dark' ? 'bento' : 'classic',
        header_style: 'classic',
        header_blur: true,
        header_blur_amount: 12,
        header_threshold: 8,
        ...layout,
      },
      covers,
    },
  };
}

async function applyConfig(next) {
  await evaljs(
    `localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(next))});
     localStorage.setItem('pp.demo.current.v1', 'usr_admin'); true`,
  );
  await goto(BASE + '/');
  await sleep(500);
}

async function openArticle() {
  await goto(`${BASE}/a/${ARTICLE_ID}`);
  await waitFor('.article-hero, .article-head');
  await sleep(700);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await goto(BASE + '/');
  await sleep(800);

  /* ---- 1. 纸白 + 图片封面：封面头、模糊底图、正文顺序 ---- */
  await applyConfig(config({ covers: [{ id: ARTICLE_ID, url: COVER_URL, position: 'center' }] }));
  await openArticle();
  await shot('01-image-hero');
  check('有封面时渲染 .article-hero', await evaljs(`!!document.querySelector('.article-hero')`));
  check(
    '标题在封面头内部',
    await evaljs(`(() => {
      const hero = document.querySelector('.article-hero');
      const title = hero?.querySelector('h1');
      return !!title && title.textContent.trim().length > 0;
    })()`),
  );
  check(
    '标题文字为白色',
    (await evaljs(`getComputedStyle(document.querySelector('.article-hero h1')).color`)) === 'rgb(255, 255, 255)',
  );
  check(
    '封面图加载成功且铺满整幅宽度',
    await evaljs(`(() => {
      const img = document.querySelector('.article-hero-media img');
      const hero = document.querySelector('.article-hero').getBoundingClientRect();
      return !!img && img.complete && img.naturalWidth > 0 && Math.abs(hero.width - window.innerWidth) <= 20;
    })()`),
  );
  check('正文顶部有模糊底图', await evaljs(`!!document.querySelector('.article-backdrop img')`));
  check(
    '元信息条位于封面之下、正文之上',
    await evaljs(`(() => {
      const hero = document.querySelector('.article-hero').getBoundingClientRect();
      const meta = document.querySelector('.article-meta--hero')?.getBoundingClientRect();
      const body = document.querySelector('.article-body')?.getBoundingClientRect();
      return !!meta && !!body && meta.top >= hero.bottom - 1 && meta.bottom <= body.top + 1;
    })()`),
  );
  check(
    '封面头里没有裂图',
    (await evaljs(`Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length`)) === 0,
  );

  /* ---- 2. 顶部透明页头：封面伸到页头后面，文字滚动前白色、滚动后回主题色 ---- */
  await applyConfig(
    config({
      layout: { header_style: 'transparent' },
      covers: [{ id: ARTICLE_ID, url: COVER_URL, position: 'center' }],
    }),
  );
  await openArticle();
  await shot('02-transparent-header');
  check(
    '透明页头下封面从页面顶端开始',
    await evaljs(`(() => {
      const hero = document.querySelector('.article-hero').getBoundingClientRect();
      const header = document.querySelector('.site-header').getBoundingClientRect();
      return hero.top <= 1 && header.top <= 1;
    })()`),
  );
  check(
    '滚动前导航文字是白色',
    await evaljs(`(() => {
      const link = document.querySelector('.site-nav a');
      return !!link && getComputedStyle(link).color === 'rgb(255, 255, 255)';
    })()`),
  );
  await evaljs('window.scrollTo(0, 600); true');
  await sleep(500);
  await shot('03-transparent-header-scrolled');
  check(
    '滚动后页头恢复主题文字色',
    await evaljs(`(() => {
      const header = document.querySelector('.site-header');
      const link = document.querySelector('.site-nav a');
      return header.classList.contains('is-scrolled') && getComputedStyle(link).color !== 'rgb(255, 255, 255)';
    })()`),
  );

  /* ---- 3. 作者隐藏封面：退回旧页头 ---- */
  await applyConfig(
    config({
      covers: [{ id: ARTICLE_ID, url: COVER_URL, position: 'center', hidden: true }],
    }),
  );
  await openArticle();
  await shot('04-cover-hidden');
  check('隐藏封面时不渲染 .article-hero', !(await evaljs(`!!document.querySelector('.article-hero')`)));
  check('隐藏封面时保留 .article-head', await evaljs(`!!document.querySelector('.article-head h1')`));

  /* ---- 4. 没有自定义封面：程序化底纹，不铺模糊底图 ---- */
  await applyConfig(config());
  await openArticle();
  await shot('05-pattern-hero');
  check('没有封面图时也渲染封面头', await evaljs(`!!document.querySelector('.article-hero .cover[data-plain="true"]')`));
  check('程序化封面里没有 <img>', !(await evaljs(`!!document.querySelector('.article-hero-media img')`)));
  check('程序化封面不铺模糊底图', !(await evaljs(`!!document.querySelector('.article-backdrop')`)));

  /* ---- 5. 夜航深色主题：标题仍为白色，不出现亮底黑字 ---- */
  await applyConfig(config({ theme: { preset: 'night', mode: 'dark' } }));
  await openArticle();
  await shot('06-night-pattern');
  check(
    '夜航主题标题仍是白色',
    (await evaljs(`getComputedStyle(document.querySelector('.article-hero h1')).color`)) === 'rgb(255, 255, 255)',
  );

  /* ---- 6. 后台「发布模式」三张卡同一行 ---- */
  await applyConfig(config());
  await goto(BASE + '/admin/settings');
  await waitFor('.option-grid.three');
  await sleep(700);
  await evaljs(`document.querySelector('.option-grid.three').scrollIntoView({ block: 'center' }); true`);
  await sleep(300);
  await shot('07-publish-mode-row');
  const publish = await evaljs(`(() => {
    const grid = Array.from(document.querySelectorAll('.option-grid.three')).find((node) =>
      node.querySelector('input[name="publish-mode-setting"]'),
    );
    if (!grid) return null;
    const cards = Array.from(grid.children);
    const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top));
    return {
      count: cards.length,
      rows: new Set(tops).size,
      labels: cards.map((card) => card.querySelector('strong')?.textContent ?? ''),
    };
  })()`);
  check('发布模式三张卡排在同一行', !!publish && publish.count === 3 && publish.rows === 1, JSON.stringify(publish?.labels));
  check(
    '发布模式标签是开放发布 / 审核发布 / 按角色发布',
    !!publish && ['开放发布', '审核发布', '按角色发布'].every((label) => publish.labels.includes(label)),
  );

  /* ---- 7. 后台媒体库：演示数据缩略图能显示 ---- */
  await goto(BASE + '/admin/media');
  await waitFor('.media-grid');
  await sleep(700);
  await shot('08-admin-media');
  const media = await evaljs(`(() => {
    const images = Array.from(document.querySelectorAll('.media-thumb img'));
    return { count: images.length, loaded: images.filter((img) => img.complete && img.naturalWidth > 0).length };
  })()`);
  check('媒体库缩略图全部显示', media.count > 0 && media.loaded === media.count, JSON.stringify(media));

  console.log(`\n控制台错误：${consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : '无'}`);
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n结果：PASS ${results.length - failed.length} / FAIL ${failed.length}（截图在 ${path.relative(process.cwd(), SHOTS)}）`);
  if (failed.length) {
    for (const entry of failed) console.log(`  FAIL ${entry.name}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('验收脚本异常：', error);
  process.exitCode = 1;
} finally {
  ws.close();
  proc.kill();
}
