/**
 * 夜航主题端到端冒烟（CDP 驱动无头 Chrome，零新增依赖）。
 * 覆盖：安装引导不再提供主题选择、夜航深色 + bento 前台、命令面板与明暗事件、
 *       演示登录、主题工坊四标签（预设 / 编排 / 思维链 / 模板）与持久化、经典主题回归。
 * 前置：apps/web 已 npm run build，且 node scripts/serve.mjs 在 127.0.0.1:80 提供服务。
 * 运行：node scripts/e2e-nightflight.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.PP_E2E_BASE ?? 'http://127.0.0.1';
const PORT = 9333;
// fileURLToPath, not .pathname: a workspace path with a space would otherwise be
// used verbatim ("Practacu%20Press") and the profile would land in a stray directory.
// The pid suffix makes every run start clean without deleting the previous profile,
// which keeps the script working in sandboxes that intercept recursive deletes.
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-profile-${process.pid}/`, import.meta.url));

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
    '--window-size=1280,900',
    BASE,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failed = [];
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed.push(name);
}
function skip(name) {
  console.log(`skip ${name}`);
}

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
    throw new Error(`页面脚本异常: ${String(d).slice(0, 300)}`);
  }
  return r.result.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1100);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');

  /* 1. 首次访问渲染安装引导（已移除主题选择器） */
  await goto(BASE + '/');
  const setup = await evaljs(`(() => ({
    wiz: !!document.querySelector('.wiz'),
    themePicker: !!document.querySelector('.wiz-theme'),
    themeCards: document.querySelectorAll('.wiz .builtin-theme-card').length,
    heading: document.querySelector('h1')?.textContent ?? '',
  }))()`);
  check('首次访问进入安装引导', setup.wiz && setup.heading.length > 0, setup.heading);
  check('安装引导不再提供主题选择', !setup.themePicker && setup.themeCards === 0);

  /* 2. 写入演示配置：夜航深色 + bento 变体 */
  const config = {
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
      theme: { preset: 'night', mode: 'dark', background: '#18171d', ink: '#f7f7fa', accent: '#c4b5fd' },
      layout: { variant: 'bento' },
      pins: [
        { id: 'cnt_house', span: '2x2' },
        { id: 'cnt_whitespace', span: '2x1' },
        { id: 'cnt_community', span: '1x1' },
      ],
    },
  };
  await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(config))})`);

  /* 3. 首页：bento 变体 + 深色 + banner + 双栏 */
  await goto(BASE + '/');
  const home = await evaljs(`(() => {
    const stage = document.querySelector('.home-stage');
    const root = getComputedStyle(document.documentElement);
    const body = document.querySelector('.pp-screen-body');
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      path: location.pathname,
      variant: stage?.dataset.variant ?? null,
      htmlVariant: document.documentElement.dataset.variant ?? null,
      blocks: document.querySelectorAll('[data-pp-block]').length,
      mode: document.documentElement.dataset.mode ?? null,
      bg: root.getPropertyValue('--bg').trim(),
      hero2: !!document.querySelector('.nf-hero-left') && !!document.querySelector('.nf-hero-right'),
      tiles: document.querySelectorAll('.nf-tile-chip, .nf-hero-tiles').length,
      heroBg: (() => {
        const left = document.querySelector('.nf-hero-left');
        return left ? getComputedStyle(left).backgroundColor : '';
      })(),
      heroCols: (() => {
        const hero = document.querySelector('.nf-hero');
        if (!hero) return [];
        return getComputedStyle(hero)
          .gridTemplateColumns.split(' ')
          .map((part) => Math.round(parseFloat(part)))
          .filter((n) => Number.isFinite(n));
      })(),
      cats: document.querySelectorAll('.nf-cat').length,
      heroSearch: !!document.querySelector('.nf-hero-search input'),
      popularRight: !!document.querySelector('.nf-hero-right.is-popular'),
      popularRows: document.querySelectorAll('.nf-popular-row').length,
      popularCovers: document.querySelectorAll('.nf-popular-cover').length,
      columns: bodyStyle ? bodyStyle.gridTemplateColumns.split(' ').length : 0,
      sideWidgets: document.querySelectorAll('.pp-screen-side .nf-widget').length,
      cards: document.querySelectorAll('.nf-tile').length,
      moreLinks: document.querySelectorAll('.nf-more-row .nf-more-link').length,
      spotHeading: document.querySelector('.nf-spot-wrap .nf-heading h2')?.textContent ?? '',
      spotTiles: [...document.querySelectorAll('.nf-spot-tile')].map((el) => el.className.replace('nf-spot-tile ', '')),
      spotCovers: document.querySelectorAll('.nf-spot-tile .nf-spot-cover .cover').length,
      legacyPageTiles: document.querySelectorAll('.nf-page-tile, .nf-pages').length,
      archive: document.querySelectorAll('.nf-archive > div').length,
    };
  })()`);
  check('首页使用 bento 变体', home.variant === 'bento' && home.htmlVariant === 'bento', `${home.variant}/${home.htmlVariant}`);
  check('首页渲染区块组件', home.blocks >= 7, `${home.blocks} 个`);
  check('夜航深色模式生效', home.mode === 'dark' && home.bg === '#18171d', `${home.mode} / ${home.bg}`);
  check('双卡首屏渲染且不再有彩色瓷砖', home.hero2 && home.tiles === 0, `${home.tiles} 个瓷砖残留`);
  check('黑卡默认纯黑底', home.heroBg === 'rgb(0, 0, 0)', home.heroBg);
  check('左卡明显宽于右卡', home.heroCols.length === 2 && home.heroCols[0] > home.heroCols[1] * 1.3, home.heroCols.join('/'));
  check('首屏黑卡底部有搜索框', home.heroSearch);
  check('首屏右卡是热门文章（默认六篇）', home.popularRight && home.popularRows === 6, `${home.popularRows} 篇`);
  check('热门榜默认不占缩略图', home.popularCovers === 0, `${home.popularCovers} 张`);
  check('分类大按钮渲染', home.cats === 3, `${home.cats} 个`);
  check('主栏 + 侧栏双列生效', home.columns === 2, `${home.columns} 列`);
  check('侧栏组件落在侧栏', home.sideWidgets >= 2, `${home.sideWidgets} 个`);
  check('封面卡双列渲染', home.cards >= 4, `${home.cards} 张`);
  check('文章列表底部有查看更多', home.moreLinks >= 1, `${home.moreLinks} 个`);
  check(
    '置顶文章按占格铺成网格',
    home.spotHeading === '置顶文章' &&
      home.spotTiles.length === 3 &&
      home.spotTiles[0]?.includes('span-2x2') &&
      home.spotTiles[1]?.includes('span-2x1') &&
      home.spotTiles[2]?.includes('span-1x1'),
    `${home.spotHeading} / ${home.spotTiles.join(',')}`,
  );
  check('置顶格子都带封面', home.spotCovers === 3, `${home.spotCovers} 张`);
  check('站点页面卡已移除', home.legacyPageTiles === 0, `${home.legacyPageTiles} 个残留`);
  check('按月归档有数据', home.archive >= 1, `${home.archive} 个月`);

  /* 4. 命令面板（事件总线） */
  await evaljs(`window.dispatchEvent(new CustomEvent('pp:interface-command', { detail: { command: 'command' } }))`);
  await sleep(400);
  const palette = await evaljs(`(() => {
    const el = document.querySelector('.pp-command');
    return { open: !!el && el.getBoundingClientRect().width > 100, items: document.querySelectorAll('.pp-command-item').length };
  })()`);
  check('命令面板打开', palette.open, `${palette.items} 项`);
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);

  /* 5. 明暗切换（事件总线） */
  await evaljs(`window.dispatchEvent(new CustomEvent('pp:interface-command', { detail: { command: 'mode' } }))`);
  await sleep(400);
  const modeAfter = await evaljs(`document.documentElement.dataset.mode`);
  check('事件总线切换明暗', modeAfter === 'light', modeAfter);
  await evaljs(`window.dispatchEvent(new CustomEvent('pp:interface-command', { detail: { command: 'mode' } }))`);
  await sleep(300);

  /* 5.5 认证页外壳：登录 / 注册不再渲染顶部 tab 导航，并给出找回密码入口 */
  await goto(BASE + '/register');
  const authShell = await evaljs(`({
    nav: !!document.querySelector('.site-nav'),
    footer: !!document.querySelector('.site-footer'),
    forgot: !!document.querySelector('a[href^="/forgot-password"]'),
    back: !!document.querySelector('.header-actions a[href="/"]'),
  })`);
  check('认证页隐藏顶部导航与页脚', !authShell.nav && !authShell.footer, JSON.stringify(authShell));
  check('认证页提供找回密码入口', authShell.forgot && authShell.back);

  /* 5.5 头部搜索：输入即搜，给出实时建议 */
  await goto(BASE + '/');
  const hasSearch = await evaljs(`!!document.querySelector('.site-search-field input')`);
  check('头部有搜索框', hasSearch);
  await evaljs(`(() => {
    const input = document.querySelector('.site-search-field input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '排版');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  await sleep(900);
  const searchHits = await evaljs(`document.querySelectorAll('.site-search-hit').length`);
  check('搜索给出实时建议', searchHits > 0, `${searchHits} 条`);
  await evaljs(`document.querySelector('.site-search-field input')?.blur()`);

  /* 6. 演示登录 */
  await goto(BASE + '/login');
  await evaljs(`(() => {
    const set = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"]');
    const pwd = document.querySelector('input[type="password"]');
    if (!email || !pwd) throw new Error('登录表单缺失');
    set(email, 'admin@practacu.local');
    set(pwd, 'practacu');
    const btn = [...document.querySelectorAll('button')].find((b) => b.type === 'submit' && b.textContent.includes('登录'));
    if (btn) btn.click();
    else document.querySelector('form')?.requestSubmit();
  })()`);
  await sleep(1400);
  const loggedIn = await evaljs(`({ path: location.pathname, admin: !!document.querySelector('a[href="/admin"]') })`);
  check('演示登录成功并回到首页', loggedIn.path === '/' && loggedIn.admin, `${loggedIn.path} / admin=${loggedIn.admin}`);

  /* 7. 进入主题工坊（懒加载路由） */
  await evaljs(`document.querySelector('a[href="/admin"]')?.click()`);
  await sleep(1300);
  const adminPath = await evaljs('location.pathname');
  check('进入管理后台', adminPath === '/admin', adminPath);
  // 后台信息架构会调整，直接进路由比点侧栏链接稳；这里要验的是懒加载路由能打开。
  await goto(BASE + '/admin/theme');
  await sleep(1800);
  const wiz = await evaljs(`(() => ({
    path: location.pathname,
    h1: document.querySelector('h1')?.textContent ?? '',
    tabs: document.querySelectorAll('.workshop-tab').length,
    cards: document.querySelectorAll('.theme-card').length,
    fullscreen: !!document.querySelector('.builder-fullscreen'),
    canvasBlocks: document.querySelectorAll('.builder-fullscreen [data-pp-block]').length,
  }))()`);
  check('页面编排懒加载打开', wiz.path === '/admin/theme' && wiz.h1.length > 0, wiz.h1);

  if (wiz.tabs === 4) {
    /* 旧四标签工坊（预设 / 首页编排 / 思维链 / 页面模板） */
    check('工坊四个标签', wiz.tabs === 4, String(wiz.tabs));
    check('工坊七套预设', wiz.cards === 7, String(wiz.cards));

    /* 8. 工坊切换预设写入本地配置 */
    await evaljs(`[...document.querySelectorAll('.theme-card')].find((c) => !c.classList.contains('is-selected'))?.click()`);
    await sleep(500);
    const presetAfter = await evaljs(`JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}')?.customization?.theme?.preset`);
    check('工坊切换预设并持久化', !!presetAfter && presetAfter !== 'night', String(presetAfter));

    /* 9. 编排标签：区块行 + 添加组件 */
    await evaljs(`[...document.querySelectorAll('.workshop-tab')].find((t) => t.textContent.includes('首页编排'))?.click()`);
    await sleep(600);
    const before = await evaljs(`document.querySelectorAll('.block-row').length`);
    const addable = await evaljs(`document.querySelectorAll('.block-add-item').length`);
    check('编排列表渲染区块行', before >= 3, `${before} 行`);
    check('添加组件菜单可用', addable >= 5, `${addable} 个可添加`);
    await evaljs(`document.querySelector('.block-add-item')?.click()`);
    await sleep(500);
    const after = await evaljs(`document.querySelectorAll('.block-row').length`);
    check('点击即添加区块', after === before + 1, `${before} → ${after}`);
    const savedBlocks = await evaljs(`JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}')?.customization?.home?.blocks?.length`);
    check('编排结果写入配置', savedBlocks === after, String(savedBlocks));

    /* 10. 思维链标签：新建一条链并加触发步骤 */
    await evaljs(`[...document.querySelectorAll('.workshop-tab')].find((t) => t.textContent.includes('思维链'))?.click()`);
    await sleep(600);
    await evaljs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建思维链'))?.click()`);
    await sleep(600);
    await evaljs(`(() => {
      const sel = document.querySelector('select[aria-label="添加触发步骤"]');
      if (!sel) throw new Error('触发步骤下拉缺失');
      sel.value = sel.options[1].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(600);
    const chain = await evaljs(`(() => ({
      steps: document.querySelectorAll('.chain-step-head').length,
      saved: JSON.parse(localStorage.getItem('pp.web.config.v1') || '{}')?.customization?.logic?.chains?.[0]?.steps?.length,
    }))()`);
    check('思维链可新建并加步骤', chain.steps === 1, `${chain.steps} 步`);
    check('思维链写入配置', chain.saved === 1, String(chain.saved));

    /* 11. 页面模板标签 */
    await evaljs(`[...document.querySelectorAll('.workshop-tab')].find((t) => t.textContent.includes('页面模板'))?.click()`);
    await sleep(600);
    const templates = await evaljs(`document.querySelectorAll('.template-card').length`);
    check('页面模板四个', templates === 4, String(templates));
  } else {
    // 工坊已改为全屏画布（.builder-fullscreen）：「预设」搬去 /admin/themes，
    // 编排 / 思维链 / 模板改成面板与页面选择。旧交互断言在这里没有对应元素，
    // 显式跳过并只验画布能画出区块，避免用旧选择器假装通过。
    skip('工坊四标签 / 七套预设 / 编排行 / 思维链 / 模板：界面已改为全屏画布，旧断言待随新工坊重写');
    check('页面编排画布打开', wiz.fullscreen, wiz.fullscreen ? '全屏画布' : '未渲染');
  }

  /* 12. 首页按新配置渲染（切回预设后 bento 仍在） */
  await goto(BASE + '/');
  const home2 = await evaljs(`(() => ({
    variant: document.querySelector('.home-stage')?.dataset.variant ?? null,
    blocks: document.querySelectorAll('[data-pp-block]').length,
  }))()`);
  check('改动后首页仍按编排渲染', home2.variant === 'bento' && home2.blocks >= 5, `${home2.variant} / ${home2.blocks}`);

  /* 12.5 写作工具栏：插入一个表格区块 */
  await goto(BASE + '/admin/content/new/article');
  const toolCount = await evaljs(`document.querySelectorAll('.rich-toolbar .tool-btn').length`);
  check('写作工具栏按钮齐全', toolCount >= 15, `${toolCount} 个`);
  await evaljs(`[...document.querySelectorAll('.tool-btn')].find((b) => b.title === '表格')?.click()`);
  await sleep(400);
  check('表格对话框打开', await evaljs(`!!document.querySelector('.modal')`));
  await evaljs(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.includes('插入表格'))?.click()`);
  await sleep(600);
  const editorBody = await evaljs(`(() => {
    const ta = document.querySelector('.editor-body');
    if (ta) return { kind: 'textarea', text: ta.value ?? '' };
    // 编辑器已换成富文本：退回读可见的表格节点
    const table = document.querySelector('.pp-table');
    return { kind: 'rich', text: table ? 'class="pp-table"' : '' };
  })()`);
  if (editorBody.kind === 'textarea') {
    check('工具栏插入表格区块', editorBody.text.includes('class="pp-table"'));
  } else {
    check('工具栏插入表格区块（富文本）', editorBody.text.includes('pp-table'), editorBody.kind);
  }

  /* 13. 回归：经典纸白主题的原体验不回退 */
  const classicConfig = {
    ...config,
    customization: { theme: { preset: 'paper', mode: 'light', background: '#ffffff', ink: '#14140f', accent: '#1f5c4a' }, layout: { variant: 'classic' } },
  };
  await evaljs(`localStorage.setItem('pp.web.config.v1', ${JSON.stringify(JSON.stringify(classicConfig))})`);
  await goto(BASE + '/');
  const classic = await evaljs(`(() => ({
    variant: document.querySelector('.home-stage')?.dataset.variant ?? null,
    blocks: document.querySelectorAll('[data-pp-block]').length,
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    banner: !!document.querySelector('.nf-hero'),
  }))()`);
  check('经典变体仍是默认体验', classic.variant === 'classic' && classic.blocks === 3 && !classic.banner, `${classic.variant} / ${classic.blocks} 区块`);
  check('纸白主题白底不回退', classic.bg === '#ffffff', classic.bg);
} catch (err) {
  console.log('ERROR ' + (err instanceof Error ? err.message : String(err)));
  failed.push('脚本异常');
} finally {
  try {
    ws.close();
  } catch {}
  proc.kill();
}

console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
