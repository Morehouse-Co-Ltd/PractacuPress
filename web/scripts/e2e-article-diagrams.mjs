#!/usr/bin/env node
/**
 * 文章写作「图表」（思维导图 / 逻辑图 / 统计图 / 鱼骨图）端到端验收
 * （CDP 驱动无头 Chrome，零新增依赖；基础设施与 e2e-features.mjs 同源）。
 *
 * 覆盖（演示数据 + 演示管理员登录）：
 * 1. `/admin/content/new/article`：填标题、聚焦正文；
 * 2. 点工具栏「图表」按钮 → `.modal-layer` 打开、`#diagram-type` 有 4 个选项、
 *    `.diagram-dialog-preview svg.pp-diagram-svg` 有真实图形元素；
 * 3. 依次插入四类图：思维导图（默认）→ 统计图（填 3 行数据）→ 鱼骨图 → 逻辑图；
 *    每次插入后断言正文出现 `pre.pp-diagram-inline` + `.pp-diagram-preview svg`，
 *    隐藏的 `code.pp-diagram-source` 里 JSON 围栏的 `"type"` 与所选类型一致；
 * 4. 点第一个图的 `.pp-diagram-edit`：弹窗标题「编辑图表」、类型/大纲回填、
 *    改图题后点「更新图表」→ 预览数量仍是 4（整块替换而不是再插一块），
 *    第一个围栏的 JSON 里出现新图题；
 * 5. 保存草稿（`.admin-page-actions` 里的「保存」），从 URL 拿稿件 id；
 * 6. 打开 `/a/{id}`：`.article-body figure.pp-diagram` 数量 = 4、四种
 *    `data-diagram-type` 齐全且每个 figure 内都有 `svg.pp-diagram-svg`；
 *    正文可见文本不含原始 JSON、图表里没有 `.code-copy`；四类图各自有
 *    图形元素（节点/连线/柱/鱼骨），并且文字与背景的对比度足够；
 * 7. Shift+D 切暗色：图表仍完整渲染，文字/背景对比度 ≥ 3，截图取证；
 * 8. 重新打开 `/admin/content/article/{id}`：4 块图表预览与隐藏围栏都还在，
 *    并直接读 localStorage 里演示后端的 `source_body` 确认 4 个
 *    ```` ```pp-diagram ```` 围栏与类型；
 * 9. 截图存 `.tmp/shots-article-diagrams/`，最后打印 PASS/FAIL 汇总，
 *    失败时退出码非 0。
 *
 * 前置：
 *   cd web
 *   # Windows 下先让 esbuild 的临时目录避开安全软件：
 *   $env:TEMP='...\\.tmpbuild\\tmp'; $env:TMP=$env:TEMP
 *   npm run build
 *   node scripts/serve.mjs --port 8099
 *
 * 运行：
 *   cd web
 *   $env:PP_E2E_BASE='http://127.0.0.1:8099'; $env:PP_E2E_PORT='9338'; node scripts/e2e-article-diagrams.mjs
 *
 * 环境变量：
 *   CHROME_PATH    Chrome / Edge 可执行文件（默认自动探测常见安装路径）
 *   PP_E2E_BASE    站点地址（默认 http://127.0.0.1:8099）
 *   PP_E2E_PORT    CDP 调试端口（默认 9338；与其它 e2e 脚本错开）
 *   PP_E2E_SHOTS   截图目录（默认 web/.tmp/shots-article-diagrams/；设 0 关闭截图）
 *
 * 断言失败时会打印当前路径、可见文案、编辑器/弹窗/阅读页的实际 DOM 概要，
 * 便于区分「功能缺陷 / 选择器过期 / 环境问题」。本脚本不修改任何业务源码。
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
const PORT = Number(process.env.PP_E2E_PORT ?? 9338);

const TMP = fileURLToPath(new URL('../.tmp/', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHOTS_RAW = (process.env.PP_E2E_SHOTS ?? '').trim();
const SHOTS_ENABLED = SHOTS_RAW !== '0';
const SHOTS_DIR = !SHOTS_ENABLED
  ? path.join(TMP, 'shots-article-diagrams')
  : SHOTS_RAW
    ? path.isAbsolute(SHOTS_RAW)
      ? SHOTS_RAW
      : path.resolve(WEB_ROOT, SHOTS_RAW)
    : path.join(TMP, 'shots-article-diagrams');
// pid 后缀让每次运行都从干净 profile 开始；不做递归删除，避免沙箱拦截。
const PROFILE = fileURLToPath(new URL(`../.tmp/chrome-profile-diagrams-${process.pid}/`, import.meta.url));

const ADMIN = { name: 'QA 验证员', email: 'admin@practacu.local', password: 'practacu-2026' };
const CONFIG_KEY = 'pp.web.config.v1';
const DEMO_STATE_KEY = 'pp.demo.state.v1';

const STAMP = String(Date.now()).slice(-6);
const ARTICLE_TITLE = `文章图表验收 ${STAMP}`;
const EDITED_TITLE = `图表验收·已编辑 ${STAMP}`;
const CHART_DATA = '一月, 12\n二月, 18\n三月, 15';
const DIAGRAM_TYPE_ORDER = ['mindmap', 'logic', 'chart', 'fishbone'];
const TYPE_LABELS = ['思维导图', '逻辑图', '统计图', '鱼骨图'];

/** 选择器候选集中在这里，实现调整时只改这一处。 */
const SEL = {
  wizard: '.wiz',
  editorTitle: '.editor-title-input',
  surface: '.rich-surface',
  toolbar: '.rich-toolbar',
  toolbarDiagram: '.rich-toolbar button[title*="图表"]',
  modal: '.modal-layer',
  modalTitle: '.modal-layer .modal-head h2',
  modalFoot: '.modal-layer .modal-foot',
  diagramType: '#diagram-type',
  diagramTitle: '#diagram-title',
  diagramOutline: '#diagram-outline',
  diagramChartData: '#diagram-chart-data',
  diagramPreview: '.diagram-dialog-preview svg.pp-diagram-svg',
  inlineBlock: '.rich-surface pre.pp-diagram-inline',
  inlinePreview: '.rich-surface pre.pp-diagram-inline .pp-diagram-preview svg.pp-diagram-svg',
  inlineSource: '.rich-surface pre.pp-diagram-inline code.pp-diagram-source',
  editButton: '.rich-surface pre.pp-diagram-inline .pp-diagram-edit',
  pageActions: '.admin-page-actions',
  articleBody: '.article-body',
  articleFigure: '.article-body figure.pp-diagram',
};

/* ------------------------------------------------------------------ */
/* 记录与输出                                                          */
/* ------------------------------------------------------------------ */

const results = [];
const shots = [];
const consoleErrors = [];
const uncaughtErrors = [];

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params?.exceptionDetails;
      uncaughtErrors.push(
        String(detail?.exception?.description ?? detail?.text ?? '未知异常').slice(0, 300),
      );
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const text = (msg.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ')
        .trim();
      if (text) consoleErrors.push(text.slice(0, 300));
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

/** 最近一次 pollValue 读取失败的异常文案（读 DOM 的脚本自身报错时用来定位）。 */
let lastPollError = '';

/** 反复读取一个值，直到 accept 通过或超时；返回最后一次读到的值（可能不满足）。 */
async function pollValue(read, accept, timeout = 10000, interval = 160) {
  const started = Date.now();
  let last = null;
  lastPollError = '';
  while (Date.now() - started < timeout) {
    try {
      last = await read();
      lastPollError = '';
    } catch (err) {
      lastPollError = err instanceof Error ? err.message : String(err);
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
      const surface = document.querySelector(${q(SEL.surface)});
      const blocks = surface ? [...surface.querySelectorAll(${q(SEL.inlineBlock)})] : [];
      const types = blocks.map((pre) => {
        try { return JSON.parse(pre.querySelector('code')?.textContent ?? '')?.type ?? null; } catch { return null; }
      });
      const layer = document.querySelector(${q(SEL.modal)});
      const typeSelect = layer ? layer.querySelector(${q(SEL.diagramType)}) : null;
      const preview = layer ? layer.querySelector(${q(SEL.diagramPreview)}) : null;
      const count = (root, sel) => (root ? root.querySelectorAll(sel).length : 0);
      const body = document.querySelector(${q(SEL.articleBody)});
      const figures = body ? [...body.querySelectorAll('figure.pp-diagram')] : [];
      return {
        path: location.pathname + location.search,
        heading: (document.querySelector('h1, h2, h3')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        mode: document.documentElement.dataset.mode ?? '',
        editor: {
          title: document.querySelector(${q(SEL.editorTitle)})?.value ?? null,
          toolbar: !!document.querySelector(${q(SEL.toolbar)}),
          surface: !!surface,
          blocks: blocks.length,
          previews: surface ? surface.querySelectorAll(${q(SEL.inlinePreview)}).length : 0,
          editButtons: surface ? surface.querySelectorAll(${q(SEL.editButton)}).length : 0,
          types,
        },
        dialog: layer
          ? {
              present: true,
              title: (layer.querySelector('.modal-head h2')?.textContent ?? '').trim(),
              typeValue: typeSelect?.value ?? '',
              options: typeSelect ? [...typeSelect.options].map((o) => (o.textContent ?? '').trim()) : [],
              preview: !!preview,
              nodes: count(preview, '.pp-diagram-node'),
              edges: count(preview, '.pp-diagram-edge'),
              bars: count(preview, '.pp-chart-bar'),
              bones: count(preview, '.pp-fishbone-bone'),
              foot: [...layer.querySelectorAll('.modal-foot button')].map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()),
            }
          : { present: false },
        article: body
          ? {
              present: true,
              figures: figures.length,
              types: figures.map((fig) => fig.getAttribute('data-diagram-type')),
              svg: figures.filter((fig) => !!fig.querySelector('svg.pp-diagram-svg')).length,
              codeCopy: body.querySelectorAll('figure.pp-diagram .code-copy').length,
              fencesLeft: body.querySelectorAll('pre code.language-pp-diagram').length,
              visible: (body.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 220),
            }
          : { present: false },
        visibleText: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      };
    })()`);
    const editor = `编辑器[title=${JSON.stringify(info.editor.title)} 图表块=${info.editor.blocks} 预览=${info.editor.previews} 类型=${info.editor.types.join(',')}]`;
    const dialog = info.dialog.present
      ? `弹窗[«${info.dialog.title}» type=${info.dialog.typeValue} options=${info.dialog.options.join('/')} 预览=${info.dialog.preview ? `${info.dialog.nodes}节点/${info.dialog.bars}柱/${info.dialog.bones}骨` : '无'} 按钮=${info.dialog.foot.join('/')}]`
      : '弹窗=未打开';
    const article = info.article.present
      ? `阅读页[figure=${info.article.figures} 类型=${info.article.types.join(',')} svg=${info.article.svg} codeCopy=${info.article.codeCopy} 残留围栏=${info.article.fencesLeft} 可见=«${info.article.visible}»]`
      : '阅读页=.article-body 缺失';
    return [
      `页面=${info.path}${info.heading ? ` «${info.heading}»` : ''} mode=${info.mode || 'light'}`,
      editor,
      dialog,
      article,
      `可见文案=«${info.visibleText || '（空）'}»`,
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

/** 通过原型 setter 写入值并派发 input + change（React 受控组件的通用做法）。 */
async function setControl(selector, value) {
  const result = await evaljs(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) {
      return {
        ok: false,
        reason: '缺失控件 ' + ${q(selector)},
        candidates: [...document.querySelectorAll('input, select, textarea')].map((node) => node.id).filter(Boolean).slice(0, 40),
      };
    }
    const tag = el.tagName;
    const proto = tag === 'SELECT'
      ? HTMLSelectElement.prototype
      : tag === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${q(String(value))});
    else el.value = ${q(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value, tag };
  })()`);
  if (!result?.ok) {
    throw new Error(
      `设置 ${selector} 失败：${result?.reason ?? 'unknown'}${result?.candidates?.length ? `；现有控件 id: ${result.candidates.join(', ')}` : ''}`,
    );
  }
  await sleep(180);
  return result;
}

/** 把光标放到正文末尾并聚焦（插入图表前必须让选区在 contenteditable 里）。 */
async function focusSurfaceAtEnd() {
  const ok = await evaljs(`(() => {
    const el = document.querySelector(${q(SEL.surface)});
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

/** 点工具栏「图表」按钮，等弹窗与实时预览出现。 */
async function openDiagramDialog() {
  const clicked = await evaljs(`(() => {
    const btn = document.querySelector(${q(SEL.toolbarDiagram)});
    if (!btn) {
      const buttons = [...document.querySelectorAll('.rich-toolbar button')];
      return {
        ok: false,
        reason: '工具栏里没有 title 含「图表」的按钮',
        candidates: buttons.map((node) => (node.title ?? node.getAttribute('aria-label') ?? '').trim()).filter(Boolean).slice(0, 40),
      };
    }
    if (btn.disabled) return { ok: false, reason: '工具栏按钮是 disabled' };
    btn.click();
    return { ok: true, title: btn.title };
  })()`);
  if (!clicked?.ok) {
    throw new Error(`${clicked?.reason ?? '点击工具栏图表按钮失败'}${clicked?.candidates?.length ? `；候选: ${clicked.candidates.join(' | ')}` : ''}`);
  }
  await waitUntil(`!!document.querySelector(${q(SEL.modal)}) && !!document.querySelector(${q(SEL.diagramPreview)})`, 15000);
  await sleep(250);
  return clicked;
}

/** 点弹窗底部按钮（按文案正则）。 */
async function clickModalFoot(pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const result = await evaljs(`(() => {
    const layer = document.querySelector(${q(SEL.modal)});
    if (!layer) return { ok: false, reason: '弹窗不存在' };
    const re = new RegExp(${q(source)});
    const buttons = [...layer.querySelectorAll('.modal-foot button')].filter((node) => node.getClientRects().length > 0);
    const el = buttons.find((node) => re.test((node.textContent ?? '').replace(/\\s+/g, ' ').trim()));
    if (!el) {
      return {
        ok: false,
        reason: '弹窗底部没有匹配 /' + ${q(String(pattern))} + '/ 的按钮',
        candidates: buttons.map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean),
      };
    }
    el.click();
    return { ok: true, label: (el.textContent ?? '').replace(/\\s+/g, ' ').trim() };
  })()`);
  if (!result?.ok) {
    throw new Error(`${result?.reason ?? 'unknown'}${result?.candidates?.length ? `；按钮: ${result.candidates.join(' / ')}` : ''}`);
  }
  await waitUntil(`!document.querySelector(${q(SEL.modal)})`, 10000);
  await sleep(300);
  return result;
}

/** 读弹窗状态（标题 / 类型选项 / 预览结构 / 字段回填）。 */
async function readDialogState() {
  return evaljs(`(() => {
    const layer = document.querySelector(${q(SEL.modal)});
    if (!layer) return { ok: false, reason: '没有 .modal-layer' };
    const typeSelect = layer.querySelector(${q(SEL.diagramType)});
    const preview = layer.querySelector(${q(SEL.diagramPreview)});
    const count = (sel) => (preview ? preview.querySelectorAll(sel).length : 0);
    const valueOf = (sel) => layer.querySelector(sel)?.value ?? '';
    return {
      ok: true,
      title: (layer.querySelector('.modal-head h2')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      typeValue: typeSelect?.value ?? '',
      options: typeSelect ? [...typeSelect.options].map((option) => (option.textContent ?? '').trim()) : [],
      preview: !!preview,
      viewBox: preview?.getAttribute('viewBox') ?? '',
      nodes: count('.pp-diagram-node'),
      roots: count('.pp-diagram-node.is-root'),
      steps: count('.pp-diagram-node.is-step'),
      edges: count('.pp-diagram-edge'),
      markerEdges: count('.pp-diagram-edge[marker-end]'),
      bars: count('.pp-chart-bar'),
      line: count('.pp-chart-line'),
      arcs: count('.pp-chart-arc'),
      legends: count('.pp-chart-legend-item'),
      bones: count('.pp-fishbone-bone'),
      causes: count('.pp-fishbone-cause'),
      empty: count('.pp-diagram-empty'),
      texts: count('text'),
      titleValue: valueOf(${q(SEL.diagramTitle)}),
      outlineValue: valueOf(${q(SEL.diagramOutline)}),
      chartDataValue: valueOf(${q(SEL.diagramChartData)}),
      labels: [...layer.querySelectorAll('.modal-foot button')].map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim()),
    };
  })()`);
}

/** 读编辑器正文里的图表块状态。 */
async function readEditorState() {
  return evaljs(`(() => {
    const surface = document.querySelector(${q(SEL.surface)});
    if (!surface) return { ok: false, reason: '没有 .rich-surface' };
    const blocks = [...surface.querySelectorAll(${q(SEL.inlineBlock)})];
    const sources = blocks.map((pre) => pre.querySelector('code.pp-diagram-source')?.textContent ?? '');
    const types = sources.map((text) => {
      try { return JSON.parse(text)?.type ?? null; } catch { return null; }
    });
    return {
      ok: true,
      blocks: blocks.length,
      previews: surface.querySelectorAll(${q(SEL.inlinePreview)}).length,
      editButtons: surface.querySelectorAll(${q(SEL.editButton)}).length,
      sources,
      types,
      titleInput: document.querySelector(${q(SEL.editorTitle)})?.value ?? null,
      path: location.pathname,
    };
  })()`);
}

/** 读阅读页图表状态 + 四类图结构 + 文字/背景对比度。 */
async function readArticleState() {
  return evaljs(`(() => {
    const body = document.querySelector(${q(SEL.articleBody)});
    if (!body) return { ok: false, reason: '没有 .article-body' };

    const parseRgb = (value) => {
      const match = String(value ?? '').match(/rgba?\\(([^)]+)\\)/);
      if (!match) return null;
      const parts = match[1].split(',').map((item) => Number.parseFloat(item.trim()));
      if (parts.length < 3 || parts.some((item) => !Number.isFinite(item))) return null;
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    // 从元素向上叠加不透明背景，得到实际画布颜色（暗色模式下 body/html 是深色）。
    const effectiveBackground = (el) => {
      const layers = [];
      for (let node = el; node; node = node.parentElement) {
        const color = parseRgb(getComputedStyle(node).backgroundColor);
        if (color) layers.push(color);
      }
      let out = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const [r, g, b, a] = layers[i];
        out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
      }
      return out.map((item) => Math.round(item));
    };
    const luminance = (rgb) => {
      const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const ratio = (a, b) => {
      const la = luminance(a);
      const lb = luminance(b);
      const light = Math.max(la, lb);
      const dark = Math.min(la, lb);
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    };

    const count = (root, sel) => (root ? root.querySelectorAll(sel).length : 0);
    const composite = (fg, bg) =>
      fg[3] >= 1
        ? [fg[0], fg[1], fg[2]]
        : [
            fg[0] * fg[3] + bg[0] * (1 - fg[3]),
            fg[1] * fg[3] + bg[1] * (1 - fg[3]),
            fg[2] * fg[3] + bg[2] * (1 - fg[3]),
          ];
    // 一段文字真正的底色：节点组里的圆角矩形、鱼骨头紧邻的水滴形矩形，否则是 figure 底色。
    const backdropOf = (text, figureBg) => {
      let rect = null;
      const group = text.closest('g');
      if (group && group.classList.contains('pp-diagram-node')) rect = group.querySelector('rect');
      const prev = text.previousElementSibling;
      if (!rect && prev && prev.tagName.toLowerCase() === 'rect' && prev.classList.contains('pp-fishbone-head')) {
        rect = prev;
      }
      const fill = rect ? parseRgb(getComputedStyle(rect).fill) : null;
      return fill ? composite(fill, figureBg) : figureBg;
    };

    const figures = [...body.querySelectorAll('figure.pp-diagram')];
    const shaped = figures.map((fig) => {
      const svg = fig.querySelector('svg.pp-diagram-svg');
      const box = svg?.getBoundingClientRect() ?? null;
      const figureBg = effectiveBackground(fig);
      const samples = svg
        ? [...svg.querySelectorAll('text')]
            .map((text) => {
              const fill = parseRgb(getComputedStyle(text).fill);
              if (!fill) return null;
              const backdrop = backdropOf(text, figureBg);
              const value = ratio(fill.slice(0, 3), backdrop);
              // 主色块/根节点上的白字是设计的一部分；var(--faint) 是弱化标签（坐标轴等）。
              // 注意：这段代码在模板字符串里，不能写正则转义，按子串判断最稳。
              const styleAttr = text.getAttribute('style') ?? '';
              const white = styleAttr.includes('#fff');
              const faint = styleAttr.includes('var(--faint)');
              return {
                fill: fill.slice(0, 3),
                backdrop,
                contrast: value,
                isWhite: white,
                isFaint: faint,
              };
            })
            .filter(Boolean)
        : [];
      const primarySamples = samples.filter((item) => !item.isWhite && !item.isFaint);
      const faintSamples = samples.filter((item) => item.isFaint);
      return {
        type: fig.getAttribute('data-diagram-type') ?? '',
        className: fig.getAttribute('class') ?? '',
        svg: !!svg,
        viewBox: svg?.getAttribute('viewBox') ?? '',
        nodes: count(fig, '.pp-diagram-node'),
        roots: count(fig, '.pp-diagram-node.is-root'),
        steps: count(fig, '.pp-diagram-node.is-step'),
        edges: count(fig, '.pp-diagram-edge'),
        markerEdges: count(fig, '.pp-diagram-edge[marker-end]'),
        bars: count(fig, '.pp-chart-bar'),
        line: count(fig, '.pp-chart-line'),
        arcs: count(fig, '.pp-chart-arc'),
        legends: count(fig, '.pp-chart-legend-item'),
        bones: count(fig, '.pp-fishbone-bone'),
        causes: count(fig, '.pp-fishbone-cause'),
        empty: count(fig, '.pp-diagram-empty'),
        texts: count(fig, 'text'),
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0,
        background: figureBg,
        // 主要内容文字（var(--ink)/var(--muted)）的最小对比度：主可读性指标。
        contrast: primarySamples.length ? Math.min(...primarySamples.map((item) => item.contrast)) : 0,
        // 弱化标签（var(--faint)，例如坐标轴刻度）的最小对比度；这类图没有弱化标签时为 null。
        faintContrast: faintSamples.length ? Math.min(...faintSamples.map((item) => item.contrast)) : null,
        // 所有文字（含主色块上的白字）的最小对比度：用来发现「字和底同色」的不可读情况。
        minTextContrast: samples.length ? Math.min(...samples.map((item) => item.contrast)) : 0,
        codeCopy: count(fig, '.code-copy'),
      };
    });

    return {
      ok: true,
      mode: document.documentElement.dataset.mode ?? '',
      tokenBgSubtle: getComputedStyle(document.documentElement).getPropertyValue('--bg-subtle').trim(),
      figures: figures.length,
      types: shaped.map((item) => item.type),
      shapes: shaped,
      fencesLeft: body.querySelectorAll('pre code.language-pp-diagram').length,
      visibleText: (body.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      htmlLength: body.innerHTML.length,
    };
  })()`);
}

/* ------------------------------------------------------------------ */
/* 截图                                                                */
/* ------------------------------------------------------------------ */

async function shot(name, options = {}) {
  if (!SHOTS_ENABLED) return '';
  const { scrollTo = '', tallHeight = 0, block = 'start' } = options;
  try {
    await mkdir(SHOTS_DIR, { recursive: true });
    if (tallHeight) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1500,
        height: tallHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(260);
    }
    if (scrollTo) {
      await evaljs(`(() => {
        const el = document.querySelector(${q(scrollTo)});
        if (!el) return false;
        el.scrollIntoView({ block: ${q(block)}, inline: 'nearest' });
        return true;
      })()`).catch(() => undefined);
      await sleep(350);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    shots.push(file);
    logLine(`  [shot] ${file}`);
    return file;
  } catch (err) {
    logLine(`  [shot] 截图失败 ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  } finally {
    if (tallHeight) {
      await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(220);
    }
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

async function fillInput(selector, value) {
  return setControl(selector, value);
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

async function prepareEnvironment() {
  console.log('\n=== 准备：七步安装向导（演示数据）+ 演示管理员登录 ===');
  await goto('/');
  await evaljs('localStorage.clear(); sessionStorage.clear(); true');
  await goto('/');
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

/* ------------------------------------------------------------------ */
/* 主流程：文章图表                                                    */
/* ------------------------------------------------------------------ */

/** viewBox 形如 `0 0 W H`，且宽高为正数（挡住 NaN / 0 尺寸的坏 SVG）。 */
function positiveViewBox(viewBox) {
  const parts = String(viewBox ?? '').trim().split(/\s+/).map(Number);
  return parts.length === 4 && parts.every((value) => Number.isFinite(value)) && parts[2] > 0 && parts[3] > 0;
}

/** 断言正文里第 expected 个图表块的类型与预览。 */
async function assertInserted(expected, type) {
  const state = await pollValue(
    readEditorState,
    (value) => value?.ok && value.blocks === expected && value.types[expected - 1] === type,
    15000,
  );
  await check(
    'INSERT',
    `第 ${expected} 次插入后正文出现 ${expected} 个 pre.pp-diagram-inline`,
    (state?.blocks ?? 0) === expected,
    `块=${state?.blocks ?? 0} 容器=${state?.previews ?? 0} 类型=[${(state?.types ?? []).join(',')}]`,
  );
  await check(
    'INSERT',
    `第 ${expected} 块的隐藏围栏 type = ${type}`,
    state?.types?.[expected - 1] === type,
    `source[${expected - 1}]=${JSON.stringify(String(state?.sources?.[expected - 1] ?? '').slice(0, 120))}`,
  );
  await check(
    'INSERT',
    `第 ${expected} 块显示 .pp-diagram-preview svg`,
    (state?.previews ?? 0) >= expected,
    `预览=${state?.previews ?? 0}`,
  );
}

async function runArticleDiagramChecks() {
  /* ---------- A. 新建文章 ---------- */
  console.log('\n=== A. 新建文章：标题 + 正文 ===');
  await goto('/admin/content/new/article');
  const editorReady = await waitUntil(`(() => {
    return !!document.querySelector(${q(SEL.editorTitle)})
      && !!document.querySelector(${q(SEL.surface)})
      && !!document.querySelector(${q(SEL.toolbar)});
  })()`, 30000);
  await check('EDITOR', '打开 /admin/content/new/article（标题 / 正文 / 工具栏就绪）', !!editorReady);
  if (!editorReady) throw new Error('新建文章编辑器没有加载出来（.editor-title-input / .rich-surface / .rich-toolbar 缺失）');
  await fillInput(SEL.editorTitle, ARTICLE_TITLE);
  await focusSurfaceAtEnd();
  await check(
    'EDITOR',
    '标题已写入 .editor-title-input',
    (await evaljs(`document.querySelector(${q(SEL.editorTitle)})?.value ?? ''`)) === ARTICLE_TITLE,
  );
  await shot('01-editor-new', { scrollTo: SEL.surface });

  /* ---------- B. 工具栏「图表」弹窗 ---------- */
  console.log('\n=== B. 工具栏「图表」弹窗 + 四类图实时预览 ===');
  const opened = await openDiagramDialog();
  await check('DIALOG', '点 .rich-toolbar button[title*="图表"] 打开 .modal-layer', !!opened?.ok, `按钮=${opened?.title ?? ''}`);

  const firstDialog = await readDialogState();
  await check('DIALOG', '弹窗标题是「插入图表」', !!firstDialog?.ok && /插入图表|Insert diagram/.test(firstDialog.title ?? ''), `实际=«${firstDialog?.title ?? ''}»`);
  await check(
    'DIALOG',
    '#diagram-type 有 4 个选项（思维导图 / 逻辑图 / 统计图 / 鱼骨图）',
    JSON.stringify(firstDialog?.options ?? []) === JSON.stringify(TYPE_LABELS),
    `实际=[${(firstDialog?.options ?? []).join(', ')}]`,
  );
  await check(
    'DIALOG',
    '默认思维导图预览有多个图形元素（节点 + 连线）',
    !!firstDialog?.preview && firstDialog.nodes >= 5 && firstDialog.edges === firstDialog.nodes - 1,
    `节点=${firstDialog?.nodes ?? 0} 连线=${firstDialog?.edges ?? 0} 预览=${firstDialog?.preview ? '有' : '无'} viewBox=${firstDialog?.viewBox ?? ''}`,
  );
  await shot('02-dialog-mindmap');

  // 思维导图（默认）→ 插入
  await clickModalFoot('插入图表');
  await assertInserted(1, 'mindmap');

  /* 统计图：切类型 → 填三行数据 → 断言柱状图结构 */
  await focusSurfaceAtEnd();
  await openDiagramDialog();
  await setControl(SEL.diagramType, 'chart');
  await waitUntil(`!!document.querySelector(${q(SEL.diagramChartData)})`, 10000);
  await setControl(SEL.diagramChartData, CHART_DATA);
  const chartDialog = await pollValue(
    readDialogState,
    (value) => value?.ok && value.typeValue === 'chart' && value.bars >= 3,
    10000,
  );
  await check(
    'DIALOG',
    '切到统计图后实时预览出现 3 根以上 .pp-chart-bar',
    (chartDialog?.bars ?? 0) >= 3,
    `type=${chartDialog?.typeValue ?? ''} 柱=${chartDialog?.bars ?? 0} 折线=${chartDialog?.line ?? 0} 图例=${chartDialog?.legends ?? 0} 数据=«${(chartDialog?.chartDataValue ?? '').replace(/\\n/g, ' / ')}»`,
  );
  await shot('03-dialog-chart');
  await clickModalFoot('插入图表');
  await assertInserted(2, 'chart');

  /* 鱼骨图 */
  await focusSurfaceAtEnd();
  await openDiagramDialog();
  await setControl(SEL.diagramType, 'fishbone');
  await waitUntil(`!!document.querySelector(${q(SEL.diagramOutline)})`, 10000);
  const fishboneDialog = await pollValue(
    readDialogState,
    (value) => value?.ok && value.typeValue === 'fishbone' && value.bones >= 2,
    10000,
  );
  await check(
    'DIALOG',
    '切到鱼骨图后实时预览出现鱼骨 + 原因',
    (fishboneDialog?.bones ?? 0) >= 2 && (fishboneDialog?.causes ?? 0) >= 2,
    `type=${fishboneDialog?.typeValue ?? ''} 骨=${fishboneDialog?.bones ?? 0} 原因=${fishboneDialog?.causes ?? 0} 大纲=«${String(fishboneDialog?.outlineValue ?? '').slice(0, 40).replace(/\\n/g, ' / ')}»`,
  );
  await shot('04-dialog-fishbone');
  await clickModalFoot('插入图表');
  await assertInserted(3, 'fishbone');

  /* 逻辑图 */
  await focusSurfaceAtEnd();
  await openDiagramDialog();
  await setControl(SEL.diagramType, 'logic');
  await waitUntil(`!!document.querySelector('#diagram-direction')`, 10000);
  const logicDialog = await pollValue(
    readDialogState,
    (value) => value?.ok && value.typeValue === 'logic' && value.markerEdges >= 2,
    10000,
  );
  await check(
    'DIALOG',
    '切到逻辑图后实时预览出现带 marker-end 的箭头连线',
    (logicDialog?.markerEdges ?? 0) >= 2 && (logicDialog?.edges ?? 0) >= 2,
    `type=${logicDialog?.typeValue ?? ''} 节点=${logicDialog?.nodes ?? 0} 连线=${logicDialog?.edges ?? 0} 箭头=${logicDialog?.markerEdges ?? 0} 方向字段=${(logicDialog?.labels ?? []).join('/')}`,
  );
  await shot('05-dialog-logic');
  await clickModalFoot('插入图表');
  await assertInserted(4, 'logic');

  /* ---------- C. 「编辑图表」回填 + 整块替换 ---------- */
  console.log('\n=== C. 点正文图表「编辑图表」：回填 + 整块替换 ===');
  const editClicked = await evaljs(`(() => {
    const btn = document.querySelector(${q(SEL.editButton)});
    if (!btn) return { ok: false, reason: '正文里没有 .pp-diagram-edit' };
    btn.click();
    return { ok: true, text: (btn.textContent ?? '').trim() };
  })()`);
  await check('EDIT', '点第一个图表的 .pp-diagram-edit 打开弹窗', !!editClicked?.ok, editClicked?.ok ? `按钮=«${editClicked.text}»` : String(editClicked?.reason ?? ''));
  await waitUntil(`!!document.querySelector(${q(SEL.modal)}) && !!document.querySelector(${q(SEL.diagramPreview)})`, 15000);
  await sleep(250);

  const editDialog = await readDialogState();
  await check('EDIT', '弹窗标题含「编辑图表」（不是「插入图表」）', !!editDialog?.ok && /编辑图表|Edit diagram/.test(editDialog.title ?? ''), `实际=«${editDialog?.title ?? ''}»`);
  await check('EDIT', '类型回填为 mindmap', editDialog?.typeValue === 'mindmap', `实际=${editDialog?.typeValue ?? ''}`);
  await check(
    'EDIT',
    '大纲字段回填非空',
    String(editDialog?.outlineValue ?? '').trim().length > 0,
    `大纲=«${String(editDialog?.outlineValue ?? '').slice(0, 60).replace(/\\n/g, ' / ')}»`,
  );
  await check('EDIT', '编辑弹窗仍有实时预览', editDialog?.preview === true && (editDialog?.nodes ?? 0) >= 5, `节点=${editDialog?.nodes ?? 0}`);
  await shot('06-dialog-edit');

  await setControl(SEL.diagramTitle, EDITED_TITLE);
  await clickModalFoot('更新图表');
  const afterEdit = await pollValue(
    readEditorState,
    (value) => value?.ok && value.blocks === 4 && String(value.sources?.[0] ?? '').includes(EDITED_TITLE),
    15000,
  );
  await check('EDIT', '更新后图表仍是 4 块（整块替换，不是新增）', (afterEdit?.blocks ?? 0) === 4, `块=${afterEdit?.blocks ?? 0} 预览=${afterEdit?.previews ?? 0}`);
  await check(
    'EDIT',
    '第一个围栏 JSON 已换成新图题（整块替换生效）',
    String(afterEdit?.sources?.[0] ?? '').includes(EDITED_TITLE) && String(afterEdit?.sources?.[0] ?? '').includes('"type":"mindmap"'),
    `source[0]=${JSON.stringify(String(afterEdit?.sources?.[0] ?? '').slice(0, 140))}`,
  );
  await check(
    'EDIT',
    '四类图顺序不变（mindmap → chart → fishbone → logic）',
    JSON.stringify(afterEdit?.types ?? []) === JSON.stringify(['mindmap', 'chart', 'fishbone', 'logic']),
    `实际=[${(afterEdit?.types ?? []).join(',')}]`,
  );
  await shot('07-editor-four-diagrams', { scrollTo: SEL.inlineBlock, tallHeight: 2600 });

  /* ---------- D. 保存草稿 ---------- */
  console.log('\n=== D. 保存草稿并拿到稿件 id ===');
  const saveClicked = await evaljs(`(() => {
    const buttons = [...document.querySelectorAll(${q(SEL.pageActions)} + ' button')];
    const visible = buttons.filter((node) => node.getClientRects().length > 0);
    const el = visible.find((node) => /保存/.test(node.textContent ?? ''));
    if (!el) {
      return { ok: false, reason: '没有匹配「保存」的按钮', candidates: visible.map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim()) };
    }
    el.click();
    return { ok: true, label: (el.textContent ?? '').replace(/\\s+/g, ' ').trim() };
  })()`);
  await check('SAVE', '点 .admin-page-actions 里的「保存」按钮', !!saveClicked?.ok, saveClicked?.ok ? `按钮=«${saveClicked.label}»` : `${saveClicked?.reason ?? ''}${saveClicked?.candidates?.length ? `；候选: ${saveClicked.candidates.join(' / ')}` : ''}`);
  const savedPath = await waitUntil(`/^\\/admin\\/content\\/article\\/[^/]+$/.test(location.pathname) ? location.pathname : ''`, 20000);
  const articleId = String(savedPath ?? '').split('/').filter(Boolean).pop() ?? '';
  await check('SAVE', '保存后跳转到 /admin/content/article/{id}', !!savedPath && /^cnt_/.test(articleId), `路径=${savedPath || '未跳转'} id=${articleId || '（空）'}`);
  if (!savedPath || !articleId) {
    throw new Error('保存草稿没有拿到稿件 id，后续阅读页验收无法继续');
  }

  /* ---------- E. 阅读页 ---------- */
  console.log(`\n=== E. 阅读页 /a/${articleId}：四类图水合成 SVG ===`);
  await goto(`/a/${articleId}`);
  const articleBodyReady = await waitUntil(`!!document.querySelector(${q(SEL.articleBody)})`, 25000).catch(() => null);
  if (!articleBodyReady) {
    await check('ARTICLE', '阅读页渲染出 .article-body', false, `读取脚本异常=${lastPollError || '（无）'}`);
    await shot('08-article-diagrams-missing');
    throw new Error('阅读页没有 .article-body（页面可能在加载中或渲染失败）');
  }
  const article = await pollValue(
    readArticleState,
    (value) => value?.ok && value.figures >= 4,
    25000,
  );
  await check('ARTICLE', '/a/{id} 的 .article-body 渲染出 4 个图表', (article?.figures ?? 0) === 4, `figure=${article?.figures ?? 0}${lastPollError ? `；读取脚本异常=${lastPollError}` : ''}${article?.reason ? `；${article.reason}` : ''}`);
  if (article?.ok && article.figures === 4) {
    const sortedTypes = [...(article.types ?? [])].sort();
    await check(
      'ARTICLE',
      '四类图齐全（mindmap / logic / chart / fishbone）',
      JSON.stringify(sortedTypes) === JSON.stringify([...DIAGRAM_TYPE_ORDER].sort()),
      `实际=[${(article.types ?? []).join(',')}]`,
    );
    await check(
      'ARTICLE',
      '每个 figure 内都有 svg.pp-diagram-svg（viewBox 宽高为正）',
      (article.shapes ?? []).every((item) => item.svg && positiveViewBox(item.viewBox)),
      `viewBox=[${(article.shapes ?? []).map((item) => item.viewBox).join(' | ')}]`,
    );
    await check(
      'ARTICLE',
      '水合后正文可见文本不含原始 JSON / 围栏',
      !/"type"\\s*:/.test(article.visibleText ?? '') && !/pp-diagram/.test(article.visibleText ?? '') && article.fencesLeft === 0,
      `残留围栏=${article.fencesLeft ?? '?'} 可见=«${String(article.visibleText ?? '').slice(0, 120)}»`,
    );
    await check(
      'ARTICLE',
      '图表容器里没有 .code-copy 复制按钮',
      (article.shapes ?? []).every((item) => item.codeCopy === 0),
      `codeCopy=[${(article.shapes ?? []).map((item) => item.codeCopy).join(',')}]`,
    );

    const byType = Object.fromEntries((article.shapes ?? []).map((item) => [item.type, item]));
    const mindmap = byType.mindmap;
    const logic = byType.logic;
    const chart = byType.chart;
    const fishbone = byType.fishbone;
    await check(
      'ARTICLE',
      '思维导图：节点 ≥ 5 且连线 = 节点 - 1',
      !!mindmap && mindmap.nodes >= 5 && mindmap.edges === mindmap.nodes - 1,
      `节点=${mindmap?.nodes ?? 0} 连线=${mindmap?.edges ?? 0} 根=${mindmap?.roots ?? 0}`,
    );
    await check(
      'ARTICLE',
      '逻辑图：有节点与带箭头的连线（marker-end）',
      !!logic && logic.nodes >= 3 && logic.markerEdges >= 1 && logic.edges === logic.nodes - 1,
      `节点=${logic?.nodes ?? 0} 连线=${logic?.edges ?? 0} 箭头=${logic?.markerEdges ?? 0}`,
    );
    await check(
      'ARTICLE',
      '统计图：柱状图有 3 根柱 + 数值/标签文字',
      !!chart && chart.bars >= 3 && chart.texts >= 3,
      `柱=${chart?.bars ?? 0} 折线=${chart?.line ?? 0} 文字=${chart?.texts ?? 0}`,
    );
    await check(
      'ARTICLE',
      '鱼骨图：鱼骨与原因都画出来了',
      !!fishbone && fishbone.bones >= 2 && fishbone.causes >= 2,
      `骨=${fishbone?.bones ?? 0} 原因=${fishbone?.causes ?? 0}`,
    );
    await check(
      'ARTICLE',
      '四张图都没有空数据占位（.pp-diagram-empty）且尺寸可读',
      (article.shapes ?? []).every((item) => item.empty === 0 && item.width >= 200 && item.height >= 40),
      `empty=[${(article.shapes ?? []).map((item) => item.empty).join(',')}] 尺寸=[${(article.shapes ?? []).map((item) => `${item.width}x${item.height}`).join(' | ')}]`,
    );
    await check(
      'ARTICLE',
      '浅色模式：主要内容文字对比度 ≥ 3、弱化标签 ≥ 2，且没有与底色同色的文字（≥ 1.8）',
      (article.shapes ?? []).every((item) =>
        item.contrast >= 3 && (item.faintContrast == null || item.faintContrast >= 2) && item.minTextContrast >= 1.8,
      ),
      `正文对比度=[${(article.shapes ?? []).map((item) => `${item.type}:${item.contrast}`).join(' | ')}] 弱化标签=[${(article.shapes ?? []).map((item) => `${item.type}:${item.faintContrast}`).join(' | ')}] 最低文字对比度=[${(article.shapes ?? []).map((item) => `${item.type}:${item.minTextContrast}`).join(' | ')}]`,
    );
  } else {
    await shot('08-article-diagrams-missing');
    throw new Error(`阅读页图表数量不是 4：figure=${article?.figures ?? 0}（实际 DOM 概要已打印在上方）`);
  }
  await shot('08-article-diagrams-light', { scrollTo: SEL.articleFigure, tallHeight: 2800 });

  /* ---------- F. 暗色模式 ---------- */
  console.log('\n=== F. 暗色模式（Shift+D）下的图表 ===');
  await evaljs(`(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', shiftKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const darkMode = await waitUntil(`document.documentElement.dataset.mode === 'dark'`, 8000);
  await check('DARK', 'Shift+D 切到暗色模式（html[data-mode=dark]）', !!darkMode, `mode=${await evaljs('document.documentElement.dataset.mode')}`);
  // 等主题令牌真正落到图表底色上（换肤是 React 副作用，读计算样式要等一帧）。
  const byDarkBg = (value) =>
    value?.ok &&
    value.mode === 'dark' &&
    value.figures === 4 &&
    (value.shapes ?? []).length === 4 &&
    (value.shapes ?? []).every((item) => (item.background ?? []).every((channel) => channel < 90));
  let darkArticle = await pollValue(readArticleState, byDarkBg, 15000);
  if (!byDarkBg(darkArticle)) {
    await sleep(600);
    darkArticle = await readArticleState().catch(() => darkArticle);
  }
  await check(
    'DARK',
    '暗色模式下四张图仍完整渲染',
    (darkArticle?.figures ?? 0) === 4 && (darkArticle?.shapes ?? []).every((item) => item.svg),
    `figure=${darkArticle?.figures ?? 0} svg=${(darkArticle?.shapes ?? []).filter((item) => item.svg).length} mode=${darkArticle?.mode ?? ''} token(--bg-subtle)=${darkArticle?.tokenBgSubtle ?? ''}`,
  );
  await check(
    'DARK',
    '暗色模式：主要内容文字对比度 ≥ 3、弱化标签 ≥ 2，且没有与底色同色的文字（≥ 1.8）',
    (darkArticle?.shapes ?? []).length === 4 &&
      (darkArticle?.shapes ?? []).every((item) =>
        item.contrast >= 3 && (item.faintContrast == null || item.faintContrast >= 2) && item.minTextContrast >= 1.8,
      ),
    `正文对比度=[${(darkArticle?.shapes ?? []).map((item) => `${item.type}:${item.contrast}`).join(' | ')}] 弱化标签=[${(darkArticle?.shapes ?? []).map((item) => `${item.type}:${item.faintContrast}`).join(' | ')}] 最低文字对比度=[${(darkArticle?.shapes ?? []).map((item) => `${item.type}:${item.minTextContrast}`).join(' | ')}] 背景=[${(darkArticle?.shapes ?? []).map((item) => `rgb(${(item.background ?? []).join(',')})`).join(' | ')}]`,
  );
  await shot('09-article-diagrams-dark', { scrollTo: SEL.articleFigure, tallHeight: 2800 });

  /* ---------- G. 保存后重开编辑器 ---------- */
  const savedSource = await evaljs(`(() => {
    try {
      const state = JSON.parse(localStorage.getItem(${q(DEMO_STATE_KEY)}) || 'null');
      const content = (state?.contents ?? []).find((item) => item.id === ${q(articleId)});
      if (!content) return { ok: false, reason: '演示状态里找不到该稿件' };
      const body = String(content.source_body ?? '');
      const open = '\`\`\`pp-diagram';
      const close = '\`\`\`';
      let rest = body;
      const types = [];
      let fences = 0;
      for (;;) {
        const at = rest.indexOf(open);
        if (at < 0) break;
        const start = at + open.length;
        const end = rest.indexOf(close, start);
        if (end < 0) break;
        fences += 1;
        try { types.push(JSON.parse(rest.slice(start, end).trim())?.type ?? null); } catch { types.push(null); }
        rest = rest.slice(end + close.length);
      }
      return {
        ok: true,
        title: content.title,
        status: content.status,
        fences,
        types,
        bodyLength: body.length,
        renderedHasFences: (content.rendered_html ?? '').includes('language-pp-diagram'),
      };
    } catch (err) {
      return { ok: false, reason: String(err && err.message ? err.message : err) };
    }
  })()`);
  await check(
    'PERSIST',
    '演示后端 source_body 里有 4 个 ```pp-diagram 围栏且类型齐全',
    !!savedSource?.ok && savedSource.fences === 4 && JSON.stringify([...(savedSource.types ?? [])].sort()) === JSON.stringify([...DIAGRAM_TYPE_ORDER].sort()),
    savedSource?.ok
      ? `围栏=${savedSource.fences} 类型=[${(savedSource.types ?? []).join(',')}] 状态=${savedSource.status} 正文=${savedSource.bodyLength} 字节`
      : String(savedSource?.reason ?? '读取失败'),
  );

  console.log(`\n=== G. 重新打开编辑器 /admin/content/article/${articleId} ===`);
  await goto(`/admin/content/article/${articleId}`);
  const reopenReady = await waitUntil(`!!document.querySelector(${q(SEL.editorTitle)}) && !!document.querySelector(${q(SEL.surface)}) && !!document.querySelector(${q(SEL.toolbar)})`, 30000);
  await check('PERSIST', '重新打开编辑器（标题 / 正文 / 工具栏就绪）', !!reopenReady);
  const reopen = await pollValue(readEditorState, (value) => value?.ok && value.blocks === 4, 20000);
  await check('PERSIST', '保存后重开：正文仍有 4 块图表', (reopen?.blocks ?? 0) === 4, `块=${reopen?.blocks ?? 0} 容器=${reopen?.previews ?? 0}`);
  await check(
    'PERSIST',
    '保存后重开：4 个隐藏围栏 JSON 都在（不丢图）',
    (reopen?.blocks ?? 0) === 4 && (reopen?.sources ?? []).every((text) => {
      try { return !!JSON.parse(text)?.type; } catch { return false; }
    }),
    `类型=[${(reopen?.types ?? []).join(',')}]`,
  );
  await check(
    'PERSIST',
    '保存后重开：4 块都有 .pp-diagram-preview svg 与「编辑图表」按钮',
    (reopen?.previews ?? 0) === 4 && (reopen?.editButtons ?? 0) === 4,
    `预览=${reopen?.previews ?? 0} 按钮=${reopen?.editButtons ?? 0}`,
  );
  await check(
    'PERSIST',
    '保存后重开：标题与编辑后的图题都还在',
    reopen?.titleInput === ARTICLE_TITLE && String(reopen?.sources?.[0] ?? '').includes(EDITED_TITLE),
    `标题=«${reopen?.titleInput ?? ''}» 第一图=«${String(reopen?.sources?.[0] ?? '').slice(0, 100)}»`,
  );
  await shot('10-editor-reopen', { scrollTo: SEL.inlineBlock, tallHeight: 2600 });
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
        `请先在 web 执行 npm run build，并让 node scripts/serve.mjs --port 8099 运行。`,
    );
  }
}

function printSummary() {
  const sections = ['SETUP', 'EDITOR', 'DIALOG', 'INSERT', 'EDIT', 'SAVE', 'ARTICLE', 'DARK', 'PERSIST', 'RUNTIME', 'RUN'];
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
  if (uncaughtErrors.length) {
    console.log(`\n页面未捕获异常 ${uncaughtErrors.length} 条：`);
    for (const item of uncaughtErrors.slice(0, 10)) console.log(`  - ${item}`);
  }
  if (consoleErrors.length) {
    console.log(`\n页面 console.error ${consoleErrors.length} 条（仅供参考）：`);
    for (const item of consoleErrors.slice(0, 10)) console.log(`  - ${item}`);
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
      fail('RUN', '准备环境', '演示管理员未就绪，跳过文章图表验收');
      return;
    }

    try {
      await runArticleDiagramChecks();
    } catch (err) {
      await check('RUN', '文章图表验收未中断', false, err instanceof Error ? err.message : String(err));
    }

    // 最后统一汇报未捕获异常（有就记一条失败，便于定位水合崩溃）。
    await check('RUNTIME', '页面没有未捕获异常', uncaughtErrors.length === 0, uncaughtErrors.slice(0, 3).join(' | '));
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
