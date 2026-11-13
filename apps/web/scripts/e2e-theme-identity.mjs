/**
 * 三套内置主题的结构差异冒烟测试（CDP，无新增依赖）。
 *
 * 前提：apps/web 的开发服务器在运行（默认 http://127.0.0.1:5173）。
 * 运行：node scripts/e2e-theme-identity.mjs
 *
 * 这个脚本不比较颜色，而比较结构：页头行数、首页组件、文章页栏数与封面形态。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.PP_E2E_BASE ?? 'http://localhost:5173';
const PORT = Number(process.env.PP_E2E_PORT ?? 9445);
const OUT = fileURLToPath(new URL('../../../.tmp/theme-identity/', import.meta.url));
const PROFILE = fileURLToPath(
  new URL(`../../../.tmp/chrome-theme-identity-${process.pid}/`, import.meta.url),
);
mkdirSync(OUT, { recursive: true });

const chrome = spawn(
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) return res.json();
    } catch {
      /* wait */
    }
    await sleep(200);
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
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 500),
    );
  }
  return result.result.value;
}

async function goto(url, wait = 1400) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

async function waitFor(expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaljs(expression)) return true;
    await sleep(200);
  }
  return false;
}

async function screenshot(name) {
  await evaljs(`(() => {
    if (!document.getElementById('pp-shot-style')) {
      const style = document.createElement('style');
      style.id = 'pp-shot-style';
      style.textContent = '.pp-anim-ready,.pp-anim-ready:not(.is-in){opacity:1!important;transform:none!important;animation:none!important;}';
      document.head.appendChild(style);
    }
    return true;
  })()`);
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${OUT}${name}.png`, Buffer.from(result.data, 'base64'));
}

function config(theme) {
  const isNight = theme === 'night';
  const isDaylight = theme === 'daylight';
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
        preset: isNight ? 'night' : isDaylight ? 'daylight' : 'paper',
        mode: isNight ? 'dark' : 'light',
        background: isNight ? '#18171d' : isDaylight ? '#fbfbfa' : '#ffffff',
        ink: isNight ? '#f7f7fa' : isDaylight ? '#111111' : '#14140f',
        accent: isNight ? '#c4b5fd' : isDaylight ? '#2457f5' : '#1f5c4a',
        heading_font: 'sans',
        body_size: 17.5,
        content_width: 720,
        radius: isNight ? 12 : isDaylight ? 12 : 6,
      },
      layout: {
        variant: isNight ? 'bento' : isDaylight ? 'daylight' : 'classic',
        header_style: 'classic',
        header_blur: true,
        header_blur_amount: 12,
        show_search: true,
        show_articles: true,
        show_posts: true,
        brand_sub: 'Independent publishing',
      },
      active_theme: isNight ? 'night' : isDaylight ? 'daylight' : 'default',
      pins: [
        { id: 'cnt_house', span: '2x2' },
        { id: 'cnt_whitespace', span: '2x1' },
        { id: 'cnt_community', span: '1x1' },
      ],
    },
  };
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function inspectHome() {
  return evaljs(`(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x) };
    };
    const header = document.querySelector('.header-inner');
    const footer = document.querySelector('.footer-brand p');
    return {
      variant: document.documentElement.dataset.variant ?? '',
      hasClassicHero: !!document.querySelector('.hero'),
      hasClassicFeed: !!document.querySelector('.feed-layout'),
      hasNfHero: !!document.querySelector('.nf-hero'),
      hasBento: !!document.querySelector('.pp-screen-bento'),
      hasDaylightFront: !!document.querySelector('.dl-front'),
      hasDaylightStories: !!document.querySelector('.dl-stories'),
      hasDaylightBriefs: !!document.querySelector('.dl-briefs'),
      hasPageSide: !!document.querySelector('.pp-screen-side'),
      headerRows: header ? getComputedStyle(header).gridTemplateRows : 'missing',
      footerTextAlign: footer ? getComputedStyle(footer).textAlign : '',
      articleHref: document.querySelector('a[href^="/a/"], a[href^="/p/"]')?.getAttribute('href') ?? '',
      box: box('.dl-front') ?? box('.nf-hero') ?? box('.hero'),
    };
  })()`);
}

async function inspectArticle() {
  return evaljs(`(() => {
    const side = document.querySelector('.article-side');
    const hero = document.querySelector('.article-hero');
    const media = document.querySelector('.article-hero-media');
    const title = document.querySelector('.article-hero h1, .article-head h1');
    const heroRect = hero?.getBoundingClientRect();
    const mediaRect = media?.getBoundingClientRect();
    return {
      hasSide: !!side,
      sideDisplay: side ? getComputedStyle(side).display : 'none',
      heroWidth: heroRect ? Math.round(heroRect.width) : 0,
      mediaRatio: heroRect && mediaRect ? Number((mediaRect.width / heroRect.width).toFixed(2)) : 0,
      titleColor: title ? getComputedStyle(title).color : '',
      hasStage: !!document.querySelector('.article-stage'),
    };
  })()`);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await goto(BASE + '/', 1600);
  await waitFor("!!document.querySelector('.header-inner')");
  console.log('initial page', await evaljs('location.href'));

  const results = {};
  for (const theme of ['classic', 'night', 'daylight']) {
    await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(config(theme)))})`);
    await goto(BASE + '/', 2200);
    await waitFor("!!document.querySelector('.header-inner')");
    const home = await inspectHome();
    if (home.headerRows === 'missing') {
      const body = await evaljs(`({ url: location.href, text: document.body.innerText.slice(0, 160) })`);
      console.log('page not mounted', theme, body);
    }
    await screenshot(`${theme}-home`);
    let article = null;
    if (home.articleHref) {
      await goto(BASE + home.articleHref, 1800);
      article = await inspectArticle();
      await screenshot(`${theme}-article`);
    }
    results[theme] = { home, article };
  }

  const classic = results.classic;
  const night = results.night;
  const daylight = results.daylight;

  check(
    'Classic：单栏 hero + feed，无白昼/夜航首页组件',
    classic.home.variant === 'classic' &&
      classic.home.hasClassicHero &&
      classic.home.hasClassicFeed &&
      !classic.home.hasDaylightFront &&
      !classic.home.hasNfHero,
    JSON.stringify(classic.home),
  );
  check('Classic：页头保持单行', !classic.home.headerRows.includes(' '), classic.home.headerRows);

  check(
    'Night：bento 双卡首页与侧栏',
    night.home.variant === 'bento' &&
      night.home.hasNfHero &&
      night.home.hasBento &&
      night.home.hasPageSide &&
      !night.home.hasDaylightFront,
    JSON.stringify(night.home),
  );
  check(
    'Night：文章页保留全幅封面',
    !!night.article && night.article.mediaRatio > 0.9,
    JSON.stringify(night.article),
  );

  check(
    'Daylight：日报首页，不带夜航组件或首页侧栏',
    daylight.home.variant === 'daylight' &&
      daylight.home.hasDaylightFront &&
      daylight.home.hasDaylightStories &&
      daylight.home.hasDaylightBriefs &&
      !daylight.home.hasNfHero &&
      !daylight.home.hasBento &&
      !daylight.home.hasPageSide,
    JSON.stringify(daylight.home),
  );
  check(
    'Daylight：单行页头，胶囊 Tab 与夜航同构',
    !daylight.home.headerRows.trim().includes(' ') || daylight.home.headerRows === 'none',
    daylight.home.headerRows,
  );
  check('Daylight：页脚居中', daylight.home.footerTextAlign === 'center', daylight.home.footerTextAlign);
  check(
    'Daylight：文章页单栏，无右栏，保留全幅封面',
    !!daylight.article &&
      daylight.article.sideDisplay === 'none' &&
      daylight.article.mediaRatio > 0.9,
    JSON.stringify(daylight.article),
  );
  check(
    'Daylight：文章标题压在封面上，使用白色文字',
    !!daylight.article && daylight.article.titleColor === 'rgb(255, 255, 255)',
    daylight.article?.titleColor ?? '',
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`screenshots: ${OUT}`);
  if (failed.length) process.exitCode = 1;
} finally {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}
