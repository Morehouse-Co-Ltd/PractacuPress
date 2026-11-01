import type {
  CustomExtension,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
} from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';
import { createExtension } from './extensions';

/**
 * 扩展工坊的示例模板。
 *
 * 每个模板都是一份完整、可直接运行的清单：CSS 只依赖沙箱注入的
 * `--pp-bg` / `--pp-ink` / `--pp-accent` / `--pp-font` 主题变量，
 * JS 只调用 window.PP 桥（getContext / setHeight / navigate 等）。
 */

export interface ExtensionTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  slots: ExtensionSlot[];
  pages: ExtensionPageScope[];
  permissions: ExtensionPermission[];
  html: string;
  css: string;
  js: string;
}

const RAW_EXTENSION_TEMPLATES: ExtensionTemplate[] = [
  {
    id: 'author-card',
    name: t('文末作者卡'),
    description: t('在文章正文之后展示一张作者名片，标题取自当前文章。'),
    icon: '作',
    slots: ['article_bottom'],
    pages: ['article'],
    permissions: [],
    html: `<section class="ppe-author" aria-label="作者卡">
  <div class="ppe-author-avatar" id="pp-author-avatar">P</div>
  <div class="ppe-author-body">
    <p class="ppe-author-kicker">本文作者</p>
    <h2 class="ppe-author-name" id="pp-author-name">Practacu Press 编辑部</h2>
    <p class="ppe-author-desc" id="pp-author-desc">在 Practacu Press 写独立出版、排版与阅读体验。</p>
    <p class="ppe-author-meta" id="pp-author-meta">感谢阅读，欢迎在评论区继续聊。</p>
  </div>
</section>`,
    css: `:root { --ppe-radius: 10px; }
.ppe-author {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  max-width: 720px;
  margin: 28px auto 8px;
  padding: 20px 22px;
  border: 1px solid color-mix(in srgb, var(--pp-ink) 12%, transparent);
  border-radius: var(--ppe-radius);
  background: color-mix(in srgb, var(--pp-ink) 4%, transparent);
}
.ppe-author-avatar {
  flex: none;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--pp-accent);
  color: #fff;
  font-size: 19px;
  font-weight: 600;
}
.ppe-author-body { min-width: 0; }
.ppe-author-kicker {
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--pp-ink) 55%, transparent);
}
.ppe-author-name { margin: 0; font-size: 17px; line-height: 1.35; }
.ppe-author-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: color-mix(in srgb, var(--pp-ink) 72%, transparent);
}
.ppe-author-meta {
  margin: 10px 0 0;
  font-size: 12px;
  color: color-mix(in srgb, var(--pp-ink) 48%, transparent);
}
@media (max-width: 480px) {
  .ppe-author { padding: 16px; gap: 12px; }
  .ppe-author-avatar { width: 38px; height: 38px; font-size: 16px; }
}`,
    js: `(function () {
  if (!window.PP) return;
  var ctx = window.PP.getContext();
  var meta = document.getElementById('pp-author-meta');
  if (meta) {
    meta.textContent = ctx.title
      ? '《' + ctx.title + '》由 Practacu Press 发布，欢迎在评论区继续聊。'
      : '感谢阅读，欢迎在评论区继续聊。';
  }
  window.PP.setHeight(document.documentElement.scrollHeight);
})();`,
  },
  {
    id: 'reading-timer',
    name: t('悬浮阅读计时'),
    description: t('右下角悬浮显示本次阅读时长，可随时暂停与继续。'),
    icon: '时',
    slots: ['floating'],
    pages: ['all'],
    permissions: [],
    html: `<div class="ppe-timer" role="group" aria-label="阅读计时">
  <span class="ppe-timer-dot" aria-hidden="true"></span>
  <span class="ppe-timer-label">已阅读</span>
  <strong class="ppe-timer-value" id="pp-timer">00:00</strong>
  <button type="button" class="ppe-timer-btn" id="pp-timer-toggle">暂停</button>
</div>`,
    css: `.ppe-timer {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--pp-ink) 16%, transparent);
  background: color-mix(in srgb, var(--pp-bg) 88%, var(--pp-ink) 12%);
  color: var(--pp-ink);
  font-size: 12.5px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  backdrop-filter: blur(6px);
}
.ppe-timer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pp-accent) 18%, transparent);
}
.ppe-timer-label { color: color-mix(in srgb, var(--pp-ink) 60%, transparent); }
.ppe-timer-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  font-weight: 600;
}
.ppe-timer-btn {
  border: 0;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11.5px;
  background: color-mix(in srgb, var(--pp-ink) 10%, transparent);
  color: inherit;
  cursor: pointer;
}
.ppe-timer-btn:hover { background: color-mix(in srgb, var(--pp-ink) 18%, transparent); }`,
    js: `(function () {
  if (!window.PP) return;
  var value = document.getElementById('pp-timer');
  var toggle = document.getElementById('pp-timer-toggle');
  var seconds = 0;
  var running = true;
  function render() {
    var mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    var ss = String(seconds % 60).padStart(2, '0');
    if (value) value.textContent = mm + ':' + ss;
  }
  window.setInterval(function () {
    if (!running) return;
    seconds += 1;
    render();
  }, 1000);
  if (toggle) {
    toggle.addEventListener('click', function () {
      running = !running;
      toggle.textContent = running ? '暂停' : '继续';
    });
  }
  render();
  window.PP.setHeight(document.documentElement.scrollHeight);
})();`,
  },
  {
    id: 'article-notice',
    name: t('文章顶部提示条'),
    description: t('在文章封面之后显示一条可关闭的提示，并可跳转到关于页。'),
    icon: '提',
    slots: ['article_top'],
    pages: ['article'],
    permissions: ['navigate'],
    html: `<aside class="ppe-note" role="note">
  <span class="ppe-note-mark" aria-hidden="true">i</span>
  <p class="ppe-note-text" id="pp-note-text">这篇文章来自 Practacu Press：内容自己保存，稿子属于作者。</p>
  <button type="button" class="ppe-note-link" id="pp-note-link">关于本站</button>
  <button type="button" class="ppe-note-close" id="pp-note-close" aria-label="关闭提示">×</button>
</aside>`,
    css: `.ppe-note {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 720px;
  margin: 18px auto;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--pp-accent) 32%, transparent);
  border-left: 3px solid var(--pp-accent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--pp-accent) 8%, transparent);
  font-size: 13px;
  line-height: 1.6;
}
.ppe-note-mark {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--pp-accent);
  color: #fff;
  font-size: 11px;
  font-style: italic;
  font-family: Georgia, serif;
}
.ppe-note-text { margin: 0; flex: 1; min-width: 0; }
.ppe-note-link {
  flex: none;
  border: 0;
  background: none;
  padding: 0;
  color: var(--pp-accent);
  font-size: 12.5px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ppe-note-close {
  flex: none;
  border: 0;
  background: none;
  padding: 2px 4px;
  font-size: 16px;
  line-height: 1;
  color: color-mix(in srgb, var(--pp-ink) 45%, transparent);
  cursor: pointer;
}
.ppe-note-close:hover { color: var(--pp-ink); }
@media (max-width: 520px) {
  .ppe-note { flex-wrap: wrap; }
  .ppe-note-text { flex-basis: calc(100% - 40px); }
}`,
    js: `(function () {
  if (!window.PP) return;
  var ctx = window.PP.getContext();
  var text = document.getElementById('pp-note-text');
  if (text && ctx.title) {
    text.textContent = '正在阅读《' + ctx.title + '》。内容自己保存，稿子属于作者。';
  }
  var link = document.getElementById('pp-note-link');
  if (link) {
    link.addEventListener('click', function () {
      window.PP.navigate('/about');
    });
  }
  var close = document.getElementById('pp-note-close');
  if (close) {
    close.addEventListener('click', function () {
      var note = document.querySelector('.ppe-note');
      if (note) note.remove();
      window.PP.setHeight(0);
    });
  }
  window.PP.setHeight(document.documentElement.scrollHeight);
})();`,
  },
];

/**
 * 模板名称与说明是界面文案，读取时翻译；html / css / js 是会被复制进用户扩展的
 * 正文，属于持久化数据，不参与翻译。
 */
export const EXTENSION_TEMPLATES = liveCatalog(RAW_EXTENSION_TEMPLATES, {
  skip: ['html', 'css', 'js'],
});

/** 按 id 找示例模板；未知 id 返回 undefined。 */
export function extensionTemplateById(id: string): ExtensionTemplate | undefined {
  return EXTENSION_TEMPLATES.find((template) => template.id === id);
}

/**
 * 由模板生成一份扩展清单（默认不启用，等站长在「我的扩展」里打开）。
 *
 * 工坊的「重置为示例」与「我的扩展 → 导入示例」都走这里，保证示例文案只维护一份。
 */
export function createExtensionFromTemplate(template: ExtensionTemplate): CustomExtension {
  return createExtension({
    name: template.name,
    version: '1.0.0',
    author: 'Practacu Press',
    description: template.description,
    icon: template.icon,
    slots: [...template.slots],
    pages: [...template.pages],
    permissions: [...template.permissions],
    html: template.html,
    css: template.css,
    js: template.js,
  });
}
