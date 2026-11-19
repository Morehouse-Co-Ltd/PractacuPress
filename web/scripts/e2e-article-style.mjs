/**
 * 夜航「文章外观」端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 覆盖两套首页文章卡外观：
 * - `cover`（默认）：封面在上、文字在下，与改造前完全一致；
 * - `blur`：封面铺满整张卡并高斯模糊，标题 / 简介 / 元信息落在卡内的毛玻璃面板上。
 *
 * 断言点：三个卡片区块（精选 / 列表 / 网格）的类名与数量、封面 computed filter、
 * 封面是否铺满卡片、文字是否落在卡内、行尾箭头是否让位、浅色模式下的深色卡面、
 * 切回默认外观时是否完全复原，以及后台「主题设置 → 文章外观」的选择与持久化。
 *
 * 前置：cd web && npm run build，并让 node scripts/serve.mjs 在 PP_E2E_BASE 提供服务
 * （或直接对 npm run dev 的 5173 跑）。
 * 运行：cd web && node scripts/e2e-article-style.mjs
 * 环境变量：CHROME_PATH / PP_E2E_BASE / PP_E2E_PORT（默认 9360）。
 * 输出：web/.tmp/shots-article-style/ 截图 + 终端 PASS/FAIL 汇总。
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
const PORT = Number(process.env.PP_E2E_PORT ?? 9360);
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS = path.join(TMP, 'shots-article-style');
await mkdir(SHOTS, { recursive: true });
const PROFILE = fileURLToPath(new URL(`../../.tmp/chrome-article-style-${process.pid}/`, import.meta.url));

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
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
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
const page = targets.find((target) => target.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('WebSocket 连接失败'));
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id == null || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
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
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`页面脚本异常: ${String(detail).slice(0, 400)}`);
  }
  return result.result.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1200);
}
async function waitFor(expression, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaljs(expression)) return true;
    await sleep(200);
  }
  return false;
}
async function shot(name) {
  // 关掉入场动画：截图里不要出现「还没滑进来」的空卡片。
  await evaljs(`(() => {
    if (!document.getElementById('pp-shot-style')) {
      const style = document.createElement('style');
      style.id = 'pp-shot-style';
      style.textContent = '.pp-anim-ready,.pp-anim-ready:not(.is-in){opacity:1!important;transform:none!important;animation:none!important;}';
      document.head.appendChild(style);
    }
    [...document.images].forEach((img) => { img.loading = 'eager'; });
    return true;
  })()`);
  await sleep(400);
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(result.data, 'base64'));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  · ${detail}` : ''}`);
}

/**
 * 演示封面：四张 1200×800 的 SVG 色块图，base64 内联。
 *
 * 用图片而不是程序化封面，是为了让「模糊背景」在截图里真的能看出是一张图；
 * data URL 不依赖网络，验收在任何机器上都能跑。
 */
function coverDataUrl(from, to, glow) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient>
<radialGradient id="r" cx="0.78" cy="0.16" r="0.62">
<stop offset="0" stop-color="${glow}" stop-opacity="0.92"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1200" height="800" fill="url(#g)"/>
<rect width="1200" height="800" fill="url(#r)"/>
<g fill="#0b0d12" opacity="0.55">
<ellipse cx="240" cy="720" rx="300" ry="170"/><ellipse cx="860" cy="760" rx="240" ry="150"/>
</g>
<g stroke="#ffffff" stroke-opacity="0.16" stroke-width="2">
<path d="M0 620 L520 380 L1200 560"/><path d="M120 0 L320 800"/>
</g>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const COVERS = [
  { id: 'cnt_house', url: coverDataUrl('#f0b06a', '#382a44', '#ffd9a0') },
  { id: 'cnt_whitespace', url: coverDataUrl('#dce9c8', '#163a28', '#f4fbe0') },
  { id: 'cnt_community', url: coverDataUrl('#141a34', '#3a1a40', '#8f9cff') },
  { id: 'cnt_workflow', url: coverDataUrl('#e8e2d6', '#b9a98f', '#fffaf0') },
  { id: 'cnt_white', url: coverDataUrl('#cfe0f4', '#22405c', '#eaf4ff') },
  { id: 'cnt_ledger', url: coverDataUrl('#f2c8a2', '#5b2f2a', '#ffe0c0') },
  { id: 'cnt_moderation', url: coverDataUrl('#2a2f3a', '#12141c', '#9fb4d8') },
  { id: 'cnt_neighbors', url: coverDataUrl('#dfe7d2', '#4a5238', '#f6ffe8') },
];

const listStyle = (style) => ({
  variant: 'bento',
  header_style: 'classic',
  header_blur: true,
  header_blur_amount: 12,
  show_search: true,
  show_articles: true,
  show_posts: true,
  brand_sub: 'Independent publishing',
  article_card_style: style,
});

const blocks = [
  { id: 'qa-feature', type: 'feature-post', title: '精选文章', props: { show_summary: true }, animation: 'none', hidden: false },
  {
    id: 'qa-list',
    type: 'post-list',
    title: '文章列表',
    props: { heading: '最新文章', limit: 3, show_summary: true, show_meta: true, show_number: true, show_more: false },
    animation: 'none',
    hidden: false,
  },
  {
    id: 'qa-grid',
    type: 'post-grid',
    title: '文章卡网格',
    props: { heading: '全部文章', tabs: true, limit: 4, show_summary: true, show_meta: true, show_more: false },
    animation: 'none',
    hidden: false,
  },
];

function config(style) {
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
      theme: {
        preset: 'night',
        mode: 'dark',
        background: '#0b0d11',
        ink: '#f2f4f8',
        accent: '#6e9bff',
        heading_font: 'serif',
        body_size: 17.5,
        content_width: 720,
        radius: 12,
      },
      layout: listStyle(style),
      active_theme: 'night',
      home: { blocks },
      verification: { enabled: false, provider: 'turnstile', site_key: '', on_login: false, on_register: false, on_comment: false, on_password_reset: false },
      comments: { enabled: true, require_review: false, notice: '' },
      extensions: { reading_progress: true, toc: true, code_copy: true, share: false, announcement: false, back_to_top: true },
      pins: [],
      covers: COVERS,
    },
  };
}

async function applyConfig(style) {
  await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(config(style)))}); true`);
  await goto(BASE + '/');
  await waitFor("!!document.querySelector('.nf-grid')");
  await sleep(800);
}

/** 读取三块卡片的结构与计算样式。 */
const MEASURE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const cardOf = (el) => el.closest('.nf-card');
  const one = (selector) => {
    const body = document.querySelector(selector);
    if (!body) return null;
    const card = cardOf(body);
    const cover = card.querySelector('.cover');
    const style = cover ? getComputedStyle(cover) : null;
    const cardBox = box(card);
    const bodyBox = box(body);
    // 封面在模糊外观下带 scale(1.07) 的过扫，getBoundingClientRect 会把变换算进去；
    // 这里用 offset 尺寸（布局尺寸）判断「是否铺满卡片」。
    const coverSize = cover ? { width: cover.offsetWidth, height: cover.offsetHeight } : null;
    const panel = getComputedStyle(body);
    return {
      cardClass: card.className,
      coverFilter: style?.filter ?? '',
      coverFillsCard:
        !!coverSize &&
        Math.abs(coverSize.width - card.clientWidth) <= 2 &&
        Math.abs(coverSize.height - card.clientHeight) <= 2,
      bodyInsideCard: bodyBox.top >= cardBox.y - 1 && bodyBox.bottom <= cardBox.y + cardBox.height + 1,
      bodyOffsetTop: Math.round(bodyBox.top - cardBox.y),
      bodyOffsetBottom: Math.round(cardBox.y + cardBox.height - (bodyBox.top + bodyBox.height)),
      panelBackdrop: panel.backdropFilter || panel.webkitBackdropFilter || 'none',
      panelRadius: panel.borderRadius,
      textColor: panel.color,
      cardBg: getComputedStyle(card).backgroundColor,
      coverRatio: coverSize && coverSize.height ? +(coverSize.width / coverSize.height).toFixed(2) : 0,
      cardRatio: +(cardBox.width / cardBox.height).toFixed(2),
    };
  };
  const all = (selector) => [...document.querySelectorAll(selector)];
  return {
    variant: document.documentElement.dataset.variant ?? '',
    mode: document.documentElement.dataset.mode ?? '',
    feature: one('.nf-feature-body'),
    list: one('.nf-row-body'),
    grid: one('.nf-tile-body'),
    blurFeature: all('.nf-feature.is-blur').length,
    blurRows: all('.nf-row.is-blur').length,
    blurTiles: all('.nf-tile.is-blur').length,
    isBlurTotal: all('.is-blur').length,
    veils: all('.nf-blur-veil').length,
    rowArrows: all('.nf-row .nf-row-arrow').length,
    rowIndexes: all('.nf-row .nf-row-index').length,
    rowCoverRatio: (() => {
      const cover = document.querySelector('.nf-row .cover');
      if (!cover || !cover.offsetHeight) return 0;
      return +(cover.offsetWidth / cover.offsetHeight).toFixed(2);
    })(),
  };
})()`;

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await goto(BASE + '/');
  await sleep(600);

  /* ---- 1. 默认外观：封面在上 ---- */
  await applyConfig('cover');
  const cover = await evaljs(MEASURE);
  await shot('1-cover-dark');
  check('默认外观：首页没有任何模糊卡片', cover && cover.isBlurTotal === 0, `count=${cover?.isBlurTotal}`);
  check('默认外观：精选大卡保持 21:9 封面', Math.abs((cover?.feature?.coverRatio ?? 0) - 21 / 9) < 0.05, `${cover?.feature?.coverRatio}`);
  check('默认外观：列表封面保持 4:3', Math.abs((cover?.rowCoverRatio ?? 0) - 4 / 3) < 0.06, `${cover?.rowCoverRatio}`);
  check('默认外观：封面只占上半张卡，文字在下方', cover?.feature?.coverFillsCard === false && (cover?.feature?.bodyOffsetTop ?? 0) > 100, `top=${cover?.feature?.bodyOffsetTop}`);
  check('默认外观：文字面板没有毛玻璃', !/blur\(/.test(cover?.feature?.panelBackdrop ?? ''), cover?.feature?.panelBackdrop);
  check('默认外观：行尾箭头仍然出现', cover?.rowArrows === 3, `arrows=${cover?.rowArrows}`);

  /* ---- 2. 模糊背景 ---- */
  await applyConfig('blur');
  const blur = await evaljs(MEASURE);
  await shot('2-blur-dark');
  check('模糊外观：变体仍是夜航深色', blur?.variant === 'bento' && blur?.mode === 'dark', `${blur?.variant}/${blur?.mode}`);
  check('模糊外观：精选 / 列表 / 网格三块都切换', blur?.blurFeature === 1 && blur?.blurRows === 3 && blur?.blurTiles === 4, `${blur?.blurFeature}/${blur?.blurRows}/${blur?.blurTiles}`);
  check('模糊外观：每张卡都盖了压暗层', blur?.veils === 8, `veils=${blur?.veils}`);
  check('模糊外观：封面套上高斯模糊', [blur?.feature, blur?.list, blur?.grid].every((card) => /blur\((7|8|9|10|11|12)px\)/.test(card?.coverFilter ?? '')), blur?.grid?.coverFilter);
  check('模糊外观：封面铺满整张卡（不是压在顶部）', [blur?.feature, blur?.list, blur?.grid].every((card) => !!card?.coverFillsCard));
  check('模糊外观：标题与简介在卡内', [blur?.feature, blur?.list, blur?.grid].every((card) => !!card?.bodyInsideCard));
  check('模糊外观：文字面板是毛玻璃', /blur\(/.test(blur?.grid?.panelBackdrop ?? ''), blur?.grid?.panelBackdrop);
  check('模糊外观：文字反白', [blur?.feature, blur?.list, blur?.grid].every((card) => /255, 255, 255/.test(card?.textColor ?? '')), blur?.grid?.textColor);
  check('模糊外观：卡面用深色底兜底', /rgb\(18, 21, 27\)/.test(blur?.grid?.cardBg ?? ''), blur?.grid?.cardBg);
  check('模糊外观：行尾箭头让位给图片', blur?.rowArrows === 0, `arrows=${blur?.rowArrows}`);
  check('模糊外观：列表序号仍然保留', blur?.rowIndexes === 3, `indexes=${blur?.rowIndexes}`);

  /* ---- 3. 浅色模式 ---- */
  await evaljs(`document.cookie = 'pp_theme=light; path=/; max-age=31536000; SameSite=Lax'; true`);
  await goto(BASE + '/');
  await waitFor("!!document.querySelector('.nf-tile.is-blur')");
  await sleep(700);
  const light = await evaljs(MEASURE);
  await shot('3-blur-light');
  check('浅色模式：模糊外观照常生效', light && light.blurTiles === 4, `tiles=${light?.blurTiles}`);
  check('浅色模式：卡面仍是深色图片卡', /rgb\(18, 21, 27\)/.test(light?.grid?.cardBg ?? ''), light?.grid?.cardBg);
  await evaljs(`document.cookie = 'pp_theme=dark; path=/; max-age=31536000; SameSite=Lax'; true`);

  /* ---- 4. 手机：单列不横向溢出 ---- */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor("!!document.querySelector('.nf-tile.is-blur')");
  await sleep(700);
  const mobile = await evaljs(`(() => {
    const measure = ${MEASURE};
    return { ...measure, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  })()`);
  await shot('4-blur-mobile');
  check('手机：单列排布且没有横向溢出', mobile?.scrollWidth <= mobile?.innerWidth + 1, `${mobile?.scrollWidth}/${mobile?.innerWidth}`);
  check('手机：卡片仍然铺满封面的模糊背景', mobile?.blurTiles === 4 && !!mobile?.grid?.coverFillsCard, `tiles=${mobile?.blurTiles}`);
  check('手机：文字面板不超出卡片', mobile?.grid?.bodyInsideCard === true);
  await send('Emulation.clearDeviceMetricsOverride');

  /* ---- 5. 切回默认外观可以完全复原 ---- */
  await applyConfig('cover');
  const back = await evaljs(MEASURE);
  await shot('5-cover-again');
  check('切回默认：模糊类名全部移除', back?.isBlurTotal === 0, `count=${back?.isBlurTotal}`);
  check('切回默认：行尾箭头回来', back?.rowArrows === 3, `arrows=${back?.rowArrows}`);

  /* ---- 6. 后台设置入口 ---- */
  await goto(BASE + '/login');
  await sleep(700);
  const hasForm = await evaljs(`!!document.querySelector('#auth-email')`);
  if (hasForm) {
    await evaljs(`(() => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#auth-email'), 'admin@practacu.local');
      set(document.querySelector('#auth-password'), 'practacu');
      const button = [...document.querySelectorAll('button')].find((node) => node.type === 'submit' && /登录/.test(node.textContent ?? ''));
      if (button) button.click(); else document.querySelector('form')?.requestSubmit();
      return true;
    })()`);
    await waitFor(`location.pathname !== '/login'`, 15000);
  }
  await goto(BASE + '/admin/themes');
  await waitFor("!!document.querySelector('.article-style-grid')", 15000);
  await sleep(600);
  const admin = await evaljs(`(() => {
    const cards = [...document.querySelectorAll('.article-style-card')];
    return {
      path: location.pathname,
      cards: cards.length,
      labels: cards.map((card) => card.querySelector('strong')?.textContent ?? ''),
      checked: cards.filter((card) => card.getAttribute('aria-checked') === 'true').length,
      checkedLabel: cards.find((card) => card.getAttribute('aria-checked') === 'true')?.querySelector('strong')?.textContent ?? '',
      hasGroup: !!document.querySelector('[role="radiogroup"][aria-label]'),
      hint: document.querySelector('.article-style-grid')?.parentElement?.querySelector('.field-hint')?.textContent ?? '',
    };
  })()`);
  await shot('6-admin-article-style');
  check('后台：文章外观两选一', admin?.cards === 2, (admin?.labels ?? []).join(' / '));
  check('后台：两个选项是封面在上 / 模糊背景', admin?.labels?.[0] === '封面在上' && admin?.labels?.[1] === '模糊背景', (admin?.labels ?? []).join(' / '));
  check('后台：当前选中项唯一', admin?.checked === 1, `checked=${admin?.checked} ${admin?.checkedLabel}`);
  check('后台：说明写清作用范围', /三个区块/.test(admin?.hint ?? ''), admin?.hint?.slice(0, 40));

  const clicked = await evaljs(`(() => {
    const card = [...document.querySelectorAll('.article-style-card')].find((node) => /模糊背景/.test(node.textContent ?? ''));
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await sleep(700);
  const after = await evaljs(`(() => ({
    checked: [...document.querySelectorAll('.article-style-card')].map((card) => card.getAttribute('aria-checked')),
    stored: JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}')?.customization?.layout?.article_card_style,
  }))()`);
  check('后台：点「模糊背景」后选中态跟着换', clicked === true && after?.checked?.[1] === 'true', JSON.stringify(after?.checked));
  check('后台：选择写进 layout.article_card_style', after?.stored === 'blur', String(after?.stored));

  await goto(BASE + '/');
  await waitFor("!!document.querySelector('.nf-tile.is-blur')");
  await sleep(600);
  const applied = await evaljs(`({
    feature: document.querySelectorAll('.nf-feature.is-blur').length,
    rows: document.querySelectorAll('.nf-row.is-blur').length,
    tiles: document.querySelectorAll('.nf-tile.is-blur').length,
  })`);
  check('后台改完回前台立即生效', applied?.feature === 1 && applied?.rows === 3 && applied?.tiles === 4, JSON.stringify(applied));

  const failed = results.filter((item) => !item.ok);
  console.log(`\n汇总：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
  if (failed.length) {
    console.log('失败项：', failed.map((item) => item.name).join('；'));
    process.exitCode = 1;
  }
} catch (err) {
  console.error('验证失败：', err);
  process.exitCode = 1;
} finally {
  try {
    ws.close();
  } catch {}
  proc.kill();
}
