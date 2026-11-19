import type {
  CustomExtension,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
} from '../types';
import {
  EXTENSION_LIMITS,
  EXTENSION_PAGE_SCOPES,
  EXTENSION_PERMISSIONS,
  EXTENSION_SLOTS,
} from './customize';
import { createExtension, newExtensionId, type ExtensionPageKind } from './extensions';
import type { ExtensionTemplate } from './extensionTemplates';
import { t } from './i18n';

/**
 * 扩展工坊的草稿逻辑。
 *
 * 管理页的「编辑 / 新建」只在本地维护一份草稿：改字段、改代码都**不写站点设计**，
 * 也不会触发任何导航或刷新；只有点「保存」才由 `buildExtensionForSave` 收敛成一份
 * 合法清单，交给 `useCustomization().update` 就地写进站点设计。这样：
 *
 * - 列表、选中项、滚动位置都保持原样（父组件只是换了一个数组元素）；
 * - 编辑器里的光标与滚动不受保存影响（草稿是组件本地 state，不随父组件重建）；
 * - 预览失败最多回退到「上次保存的清单」，草稿本身不被污染，仍然可以保存。
 *
 * 这里全部是纯函数，方便单测。
 */

/** 草稿里与清单一一对应的字段；`updated_at` / `created_at` 不参与「有未保存修改」判断。 */
const DRAFT_FIELDS = [
  'name',
  'version',
  'author',
  'description',
  'icon',
  'enabled',
  'slots',
  'pages',
  'permissions',
  'html',
  'css',
  'js',
] as const;

/** 新建扩展的空白草稿：名称留空由页面校验，保存时再兜底成「未命名扩展」。 */
export function emptyExtensionDraft(now: string = new Date().toISOString()): CustomExtension {
  return {
    id: newExtensionId(),
    name: '',
    version: '1.0.0',
    author: '',
    description: '',
    icon: '',
    enabled: false,
    slots: ['article_bottom'],
    pages: ['all'],
    permissions: [],
    html: '',
    css: '',
    js: '',
    created_at: now,
    updated_at: now,
  };
}

/**
 * 从已保存的清单复制一份草稿。
 *
 * 数组必须复制：编辑时直接 `push` 会改到站点设计里的同一个数组，等于绕过保存偷偷
 * 落盘（而且 React 也感知不到）。
 */
export function extensionDraftFrom(extension: CustomExtension): CustomExtension {
  return {
    ...extension,
    slots: [...extension.slots],
    pages: [...extension.pages],
    permissions: [...extension.permissions],
  };
}

/** 文本字段按去掉首尾空白后比较：保存时会 trim，尾随空格不算改动。 */
function sameText(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * 草稿相对已保存的清单是否有改动。
 *
 * 不比较 `updated_at`：每次保存都会变，否则保存完立刻又显示「有未保存修改」。
 */
export function extensionDraftDirty(draft: CustomExtension, saved: CustomExtension | null): boolean {
  if (!saved) return true;
  for (const field of DRAFT_FIELDS) {
    const left = draft[field];
    const right = saved[field];
    if (field === 'enabled') {
      if ((left === true) !== (right === true)) return true;
      continue;
    }
    if (field === 'slots' || field === 'pages' || field === 'permissions') {
      if (!sameList(left as string[], right as string[])) return true;
      continue;
    }
    if (!sameText(left as string, right as string)) return true;
  }
  return false;
}

/** 保存前的校验；返回空串表示可以保存。 */
export function validateExtensionDraft(draft: CustomExtension): string {
  if (!draft.name.trim()) return t('请先填写扩展名称');
  return '';
}

/**
 * 勾选 / 取消勾选后的新数组。
 *
 * 按清单常量的顺序输出，避免「先勾 A 再勾 B」和「先勾 B 再勾 A」产生两份内容相同
 * 但顺序不同的配置（会让 dirty 判断与导出结果不稳定）。
 */
function toggleIn<T extends string>(list: readonly T[], value: T, allowed: readonly T[]): T[] {
  const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return allowed.filter((item) => next.includes(item));
}

export function toggleDraftSlot(draft: CustomExtension, slot: ExtensionSlot): CustomExtension {
  return { ...draft, slots: toggleIn(draft.slots, slot, EXTENSION_SLOTS) };
}

export function toggleDraftPage(draft: CustomExtension, page: ExtensionPageScope): CustomExtension {
  return { ...draft, pages: toggleIn(draft.pages, page, EXTENSION_PAGE_SCOPES) };
}

export function toggleDraftPermission(
  draft: CustomExtension,
  permission: ExtensionPermission,
): CustomExtension {
  return { ...draft, permissions: toggleIn(draft.permissions, permission, EXTENSION_PERMISSIONS) };
}

/**
 * 把示例模板填进草稿：id / 创建时间 / 启用状态保留，内容整体替换。
 *
 * 这样从模板起步的扩展仍然是「同一个正在编辑的对象」，不会因为套模板变成另一条清单。
 */
export function applyTemplateToDraft(
  draft: CustomExtension,
  template: ExtensionTemplate,
): CustomExtension {
  return {
    ...draft,
    name: template.name,
    description: template.description,
    icon: template.icon,
    slots: [...template.slots],
    pages: [...template.pages],
    permissions: [...template.permissions],
    html: template.html,
    css: template.css,
    js: template.js,
  };
}

/**
 * 收敛成可保存的清单。
 *
 * 走 `createExtension`：长度截断、枚举过滤、空名称 / 空作者 / 空槽位兜底都复用
 * 导入与读取本地配置的同一条规则。`created_at` 保留首次创建时间，`updated_at`
 * 每次保存都刷新——前台 iframe 靠它重挂，让新脚本立刻生效。
 */
export function buildExtensionForSave(
  draft: CustomExtension,
  previous: CustomExtension | null = null,
): CustomExtension {
  return createExtension({
    ...draft,
    created_at: previous?.created_at ?? draft.created_at,
  });
}

/** 内容字段的长度用量：用于在编辑器下方显示计数与「超出上限」提醒。 */
export function extensionCodeUsage(draft: CustomExtension): {
  html: number;
  css: number;
  js: number;
} {
  return { html: draft.html.length, css: draft.css.length, js: draft.js.length };
}

/** 某个内容字段是否已超出保存上限（保存时会被截断，需要先提示）。 */
export function extensionCodeOverLimit(
  field: 'html' | 'css' | 'js',
  length: number,
): boolean {
  return length > EXTENSION_LIMITS[field];
}

/**
 * 预览用哪种页面类型。
 *
 * 优先文章页：扩展最常挂在那里，而且只有文章页有标题上下文可以展示。
 * 「全部页面」与空数组都按文章页预览。
 */
export function extensionPreviewPageKind(pages: readonly ExtensionPageScope[]): ExtensionPageKind {
  if (!pages.length || pages.includes('all') || pages.includes('article')) return 'article';
  if (pages.includes('home')) return 'home';
  if (pages.includes('list')) return 'list';
  return 'search';
}

/** 预览区是否还有内容可看；三项全空时提示先写点东西。 */
export function extensionHasContent(draft: Pick<CustomExtension, 'html' | 'css' | 'js'>): boolean {
  return Boolean(draft.html.trim() || draft.css.trim() || draft.js.trim());
}
