/**
 * 页头样式端到端验收（CDP 驱动无头 Chrome，零新增依赖）。
 *
 * 覆盖：classic / transparent / float 三种样式在滚动前 / 后的外观、高斯模糊开关、
 * 滚动阈值、夜航深色，以及后台「主题设置 → 导航与页脚 → 页头样式」三选一。
 * float 额外验证「从外往里收」的过程：中部宽度、最终 1180px、scale(0.97) 与 logo 内移。
 * 注意：无头 Chrome 默认匹配 prefers-reduced-motion: reduce，脚本会显式模拟 no-preference。
 *
 * 前置：cd web && npm run build，并让 node scripts/serve.mjs 在 PP_E2E_BASE 提供服务
 * （或对 npm run dev 的 5173 跑）。
 * 运行：cd web && node scripts/e2e-header.mjs
 * 环境变量：CHROME_PATH / PP_E2E_BASE / PP_E2E_PORT（默认 9350）。
 * 输出：web/.tmp/shots-header/ 截图 + 终端 PASS/FAIL 汇总。
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
const PORT = Number(process.env.PP_E2E_PORT ?? 9350);
const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SHOTS = path.join(TMP, 'shots-header');
await mkdir(SHOTS, { recursive: true });
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-header-${process.pid}/`, import.meta.url));

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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  · ${detail}` : ''}`);
}

function config(overrides) {
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
      theme: { preset: 'paper', mode: 'light' },
      layout: { variant: 'classic', header_style: 'classic', header_blur: true, header_blur_amount: 12, header_threshold: 8 },
      ...overrides,
    },
  };
}

async function applyConfig(next) {
  await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(next))}); true`);
  await goto(BASE + '/');
  await sleep(900);
}

const MEASURE = `(() => {
  const header = document.querySelector('.site-header');
  const inner = document.querySelector('.header-inner');
  if (!header || !inner) return null;
  const hs = getComputedStyle(header);
  const is = getComputedStyle(inner);
  return {
    scrollY: Math.round(window.scrollY),
    scrolled: header.classList.contains('is-scrolled'),
    headerBg: hs.backgroundColor,
    headerBlur: hs.backdropFilter || hs.webkitBackdropFilter || 'none',
    headerShadow: hs.boxShadow,
    headerPadTop: hs.paddingTop,
    headerBorder: hs.borderBottomColor,
    innerBg: is.backgroundColor,
    innerBlur: is.backdropFilter || is.webkitBackdropFilter || 'none',
    innerShadow: is.boxShadow,
    innerRadius: is.borderRadius,
    innerWidth: Math.round(inner.getBoundingClientRect().width),
    // offsetWidth 不受 transform 缩放影响，用来断言「胶囊布局宽度」是否收到 1180px。
    innerOffsetWidth: Math.round(inner.offsetWidth),
    innerTransform: is.transform,
    innerPadding: is.paddingLeft,
    brandLeft: Math.round(document.querySelector('.brand')?.getBoundingClientRect().left ?? -1),
    styleAttr: document.documentElement.dataset.headerStyle,
  };
})()`;

const opaque = (value) => {
  if (!value || value === 'transparent') return false;
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return true;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return parts.length < 4 || parts[3] > 0.05;
};
const blurred = (value) => /blur\(/.test(value || '');

try {
  await send('Page.enable');
  await send('Runtime.enable');
  // 无头 Chrome 默认匹配 prefers-reduced-motion: reduce，会让所有过渡瞬间完成；
  // 这里显式模拟「允许动效」，才能验证悬浮胶囊的收缩过程。
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  // 先落到真实站点：Chrome 启动目标可能还是 about:blank，读不了 localStorage。
  await goto(BASE + '/');
  await sleep(900);

  /* ---- 1. 经典吸顶 + 模糊 ---- */
  await applyConfig(config());
  const classicTop = await evaljs(MEASURE);
  await shot('classic-light-top');
  await evaljs('window.scrollTo(0, 900); true');
  await sleep(500);
  const classicScrolled = await evaljs(MEASURE);
  await shot('classic-light-scrolled');

  check('经典样式：滚动前不显示滚动态', classicTop && !classicTop.scrolled, `scrollY=${classicTop?.scrollY}`);
  check('经典样式：滚动后加上 is-scrolled', !!classicScrolled?.scrolled, `scrollY=${classicScrolled?.scrollY}`);
  check('经典样式：滚动后出现阴影', classicScrolled?.headerShadow !== 'none');
  check('经典样式：开启模糊时背景模糊生效', blurred(classicScrolled?.headerBlur), classicScrolled?.headerBlur);

  /* ---- 2. 顶部透明 ---- */
  await applyConfig(config({ layout: { variant: 'classic', header_style: 'transparent', header_blur: true, header_blur_amount: 12, header_threshold: 8 } }));
  const transparentTop = await evaljs(MEASURE);
  await shot('transparent-light-top');
  await evaljs('window.scrollTo(0, 900); true');
  await sleep(500);
  const transparentScrolled = await evaljs(MEASURE);
  await shot('transparent-light-scrolled');

  check('顶部透明：页首背景透明', transparentTop && !opaque(transparentTop.headerBg), transparentTop?.headerBg);
  check('顶部透明：页首不做模糊', transparentTop && !blurred(transparentTop.headerBlur), transparentTop?.headerBlur);
  check('顶部透明：滚动后出现底色', transparentScrolled && opaque(transparentScrolled.headerBg), transparentScrolled?.headerBg);
  check('顶部透明：滚动后模糊生效', transparentScrolled && blurred(transparentScrolled.headerBlur));

  /* ---- 3. 悬浮胶囊 ---- */
  await applyConfig(config({ layout: { variant: 'classic', header_style: 'float', header_blur: true, header_blur_amount: 14, header_threshold: 8 } }));
  const floatTop = await evaljs(MEASURE);
  await shot('float-light-top');
  await evaljs('window.scrollTo(0, 900); true');
  // 收缩动画进行到一半时取样：宽度应严格处于两端之间，证明不是瞬间跳变。
  await sleep(140);
  const floatMid = await evaljs(MEASURE);
  await shot('float-light-mid');
  await sleep(600);
  const floatScrolled = await evaljs(MEASURE);
  await shot('float-light-scrolled');

  check('悬浮胶囊：页首整条页头透明', floatTop && !opaque(floatTop.headerBg), floatTop?.headerBg);
  check('悬浮胶囊：页首胶囊透明', floatTop && !opaque(floatTop.innerBg), floatTop?.innerBg);
  check('悬浮胶囊：滚动后胶囊出现底色', floatScrolled && opaque(floatScrolled.innerBg), floatScrolled?.innerBg);
  check('悬浮胶囊：滚动后胶囊有圆角', Number.parseFloat(floatScrolled?.innerRadius || '0') >= 12, floatScrolled?.innerRadius);
  check('悬浮胶囊：滚动后胶囊浮起（阴影）', floatScrolled?.innerShadow !== 'none');
  check('悬浮胶囊：滚动后胶囊高斯模糊', floatScrolled && blurred(floatScrolled.innerBlur), floatScrolled?.innerBlur);
  check('悬浮胶囊：宽度不超过 1280px', (floatScrolled?.innerWidth ?? 9999) <= 1282, `${floatScrolled?.innerWidth}px`);
  check(
    '悬浮胶囊：顶部与内容同宽、滚动后收窄',
    !!floatTop && !!floatScrolled && floatTop.innerOffsetWidth > floatScrolled.innerOffsetWidth + 100,
    `${floatTop?.innerOffsetWidth}px → ${floatScrolled?.innerOffsetWidth}px`,
  );
  check(
    '悬浮胶囊：收缩过程有中间帧（不是瞬间跳变）',
    !!floatTop && !!floatScrolled && !!floatMid &&
      floatMid.innerOffsetWidth < floatTop.innerOffsetWidth &&
      floatMid.innerOffsetWidth > floatScrolled.innerOffsetWidth,
    `mid=${floatMid?.innerOffsetWidth}px`,
  );
  check(
    '悬浮胶囊：收起后布局宽度约 1180px',
    Math.abs((floatScrolled?.innerOffsetWidth ?? 0) - 1180) <= 2,
    `${floatScrolled?.innerOffsetWidth}px`,
  );
  check(
    '悬浮胶囊：收起时有很轻的整体缩放',
    /0\.97/.test(floatScrolled?.innerTransform ?? ''),
    floatScrolled?.innerTransform,
  );
  check(
    '悬浮胶囊：logo 向中心移动',
    !!floatTop && !!floatScrolled && floatScrolled.brandLeft > floatTop.brandLeft + 30,
    `${floatTop?.brandLeft}px → ${floatScrolled?.brandLeft}px`,
  );

  /* ---- 4. 关闭模糊 ---- */
  await applyConfig(config({ layout: { variant: 'classic', header_style: 'float', header_blur: false, header_blur_amount: 14, header_threshold: 8 } }));
  await evaljs('window.scrollTo(0, 900); true');
  await sleep(500);
  const noBlur = await evaljs(MEASURE);
  check('关闭模糊：胶囊不做高斯模糊', noBlur && !blurred(noBlur.innerBlur), noBlur?.innerBlur);
  check('关闭模糊：胶囊使用实色背景', noBlur && opaque(noBlur.innerBg), noBlur?.innerBg);

  /* ---- 5. 滚动阈值 ---- */
  await applyConfig(config({ layout: { variant: 'classic', header_style: 'float', header_blur: true, header_blur_amount: 12, header_threshold: 120 } }));
  await evaljs('window.scrollTo(0, 60); true');
  await sleep(400);
  const belowThreshold = await evaljs(MEASURE);
  await evaljs('window.scrollTo(0, 220); true');
  await sleep(400);
  const aboveThreshold = await evaljs(MEASURE);
  check('阈值：未超过时不切换', belowThreshold && !belowThreshold.scrolled, `scrollY=${belowThreshold?.scrollY}`);
  check('阈值：超过后切换', aboveThreshold && aboveThreshold.scrolled, `scrollY=${aboveThreshold?.scrollY}`);

  /* ---- 6. 深色主题 + 悬浮胶囊 ---- */
  await applyConfig(
    config({
      theme: { preset: 'night', mode: 'dark' },
      active_theme: 'night',
      layout: { variant: 'bento', header_style: 'float', header_blur: true, header_blur_amount: 16, header_threshold: 8 },
    }),
  );
  await evaljs('window.scrollTo(0, 900); true');
  await sleep(600);
  await shot('float-night-scrolled');
  const nightFloat = await evaljs(MEASURE);
  check('夜航深色：胶囊滚动后生效', nightFloat && nightFloat.scrolled && opaque(nightFloat.innerBg), nightFloat?.innerBg);
  check('夜航深色：胶囊模糊生效', nightFloat && blurred(nightFloat.innerBlur));

  /* ---- 7. 后台设置入口 ---- */
  await goto(BASE + '/login');
  await sleep(700);
  const hasForm = await evaljs(`!!document.querySelector('input[type="email"]')`);
  if (hasForm) {
    await evaljs(`(() => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('input[type="email"]'), 'admin@practacu.local');
      set(document.querySelector('input[type="password"]'), 'practacu');
      const button = [...document.querySelectorAll('button')].find((node) => node.type === 'submit' && /登录/.test(node.textContent ?? ''));
      if (button) button.click(); else document.querySelector('form')?.requestSubmit();
      return true;
    })()`);
    await sleep(1500);
  }
  await goto(BASE + '/admin/themes');
  await sleep(1200);
  await evaljs(`(() => {
    const tab = [...document.querySelectorAll('.seg button')].find((node) => /导航与页脚/.test(node.textContent ?? ''));
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(600);
  const adminPanel = await evaljs(`(() => {
    const cards = [...document.querySelectorAll('.header-style-card')];
    return {
      cards: cards.length,
      labels: cards.map((card) => card.querySelector('strong')?.textContent ?? ''),
      checked: cards.filter((card) => card.getAttribute('aria-checked') === 'true').length,
      hasBlurToggle: !![...document.querySelectorAll('[role="switch"]')].find((node) => /背景高斯模糊/.test(node.getAttribute('aria-label') ?? '')),
    };
  })()`);
  await shot('admin-header-style-panel');
  check('后台：页头样式三选一存在', adminPanel?.cards === 3, (adminPanel?.labels ?? []).join(' / '));
  check('后台：当前样式有选中态', adminPanel?.checked === 1);
  check('后台：模糊开关存在', !!adminPanel?.hasBlurToggle);

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
