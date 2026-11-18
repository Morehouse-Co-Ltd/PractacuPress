import { useSyncExternalStore } from 'react';
import type { IconName } from '../../components/Icon';
import type { AdminPageDefinition, AdminPageGroup, Disposable } from './types';

/**
 * 后台页面的扩展注册表。
 *
 * 模式与 `SlotRegistry`（registry.ts）一致：一个进程级单例 + `useSyncExternalStore`
 * 订阅，宿主（AdminShell / AdminExtensionPage）只读，扩展（包括内置扩展）只能通过
 * 运行时给的 `context.admin.registerPage()` 写入。这样“性能面板是扩展提供的内容”
 * 不是文案，而是同一个注册通道上的一个条目。
 *
 * 刻意做成框架无关的类：单元测试直接 new 一个实例，不共享全局状态。
 */

export interface AdminPageEntry {
  pluginID: string;
  page: AdminPageDefinition;
  /** 已归一化的排序值：注册时解析一次，之后不再读扩展对象的 getter。 */
  order: number;
  sequence: number;
}

/** `/admin/ext/{path}` 的 slug：小写字母开头，允许数字、连字符与下划线。 */
const PAGE_SLUG = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export class AdminPageRegistry {
  private entries: AdminPageEntry[] = [];
  private ordered: AdminPageEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private sequence = 0;

  /** Stable subscription for useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Monotonic revision; useful as an alternative useSyncExternalStore snapshot. */
  readonly getVersion = (): number => this.revision;

  /** All pages, sorted by `order` then registration order. Stable between changes. */
  readonly list = (): AdminPageEntry[] => this.ordered;

  /** One page by URL slug (the value used in `/admin/ext/{slug}`). */
  resolve(slug: string): AdminPageEntry | undefined {
    return this.entries.find((entry) => entry.page.path === slug);
  }

  /** Registers one page for a plugin and returns its disposer. */
  register(pluginID: string, page: AdminPageDefinition): Disposable {
    if (typeof pluginID !== 'string' || !pluginID) {
      throw new Error('plugin id is required to register an admin page');
    }
    validatePage(page);
    if (this.entries.some((entry) => entry.page.path === page.path)) {
      throw new Error(`admin page path "${page.path}" is already registered`);
    }
    if (
      this.entries.some((entry) => entry.pluginID === pluginID && entry.page.id === page.id)
    ) {
      throw new Error(`admin page ${pluginID}/${page.id} is already registered`);
    }
    const entry: AdminPageEntry = {
      pluginID,
      page,
      order: Number.isFinite(page.order) ? Number(page.order) : 0,
      sequence: ++this.sequence,
    };
    this.entries = [...this.entries, entry];
    this.rebuild();
    return () => this.remove(pluginID, page.id);
  }

  /** Removes every page owned by one plugin (used on unload/failure). */
  clearPlugin(pluginID: string): void {
    const next = this.entries.filter((entry) => entry.pluginID !== pluginID);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.rebuild();
  }

  private remove(pluginID: string, id: string): void {
    const next = this.entries.filter(
      (entry) => !(entry.pluginID === pluginID && entry.page.id === id),
    );
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.rebuild();
  }

  private rebuild(): void {
    this.ordered = [...this.entries].sort(
      (left, right) => left.order - right.order || left.sequence - right.sequence,
    );
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

function validatePage(page: AdminPageDefinition): void {
  if (!page || typeof page !== 'object') {
    throw new Error('admin page definition is not an object');
  }
  if (typeof page.id !== 'string' || !page.id.trim()) {
    throw new Error('admin page id is required');
  }
  if (typeof page.path !== 'string' || !PAGE_SLUG.test(page.path)) {
    throw new Error(`admin page path "${String(page.path)}" is invalid`);
  }
  if (typeof page.label !== 'string' || !page.label.trim()) {
    throw new Error(`admin page ${page.path} needs a label`);
  }
  if (typeof page.render !== 'function') {
    throw new Error(`admin page ${page.path} needs a render function`);
  }
}

/** Normalised navigation group for a page; unknown values fall back to extensions. */
export function adminPageGroup(page: Pick<AdminPageDefinition, 'group'>): AdminPageGroup {
  return page.group === 'overview' ? 'overview' : 'extensions';
}

/**
 * The icon a nav entry actually renders. The registry does not reject a bad
 * icon (a plugin may target a newer host), it just falls back to `grid` so the
 * sidebar never shows an empty 15×15 box.
 *
 * Keep this list in sync with `components/Icon.tsx`. A name missing here is
 * harmless — it only degrades to `grid`.
 */
const ADMIN_ICON_NAMES: ReadonlySet<string> = new Set<IconName>([
  'home',
  'file',
  'message',
  'search',
  'bell',
  'mail',
  'user',
  'users',
  'settings',
  'shield',
  'image',
  'clock',
  'logout',
  'plus',
  'chevron-down',
  'chevron-right',
  'chevron-left',
  'arrow-right',
  'arrow-left',
  'arrow-up-right',
  'check',
  'check-circle',
  'close',
  'alert',
  'info',
  'x-circle',
  'eye',
  'edit',
  'bookmark',
  'heart',
  'reply',
  'send',
  'trash',
  'refresh',
  'upload',
  'download',
  'copy',
  'external',
  'menu',
  'sparkle',
  'database',
  'server',
  'lock',
  'globe',
  'grid',
  'list',
  'filter',
  'more',
  'code',
  'thumb',
  'minus',
  'arrow-up',
  'palette',
  'layers',
  'sun',
  'moon',
  'tag',
  'chart',
  'activity',
  'command',
  'video',
  'link',
  'table',
  'columns',
  'quote',
  'bulb',
  'github',
  'x',
  'mastodon',
  'rss',
]);

/** Icon for a page's nav entry, with `grid` fallback for unknown names. */
export function adminPageIcon(page: Pick<AdminPageDefinition, 'icon'>): IconName {
  const icon = page.icon;
  return typeof icon === 'string' && ADMIN_ICON_NAMES.has(icon) ? (icon as IconName) : 'grid';
}

/**
 * The process-wide admin page registry. The admin shell sits deep inside the
 * provider tree and the route component is outside it, so a module singleton is
 * the narrowest seam; tests create their own instance.
 */
export const adminPageRegistry = new AdminPageRegistry();

/** React binding: re-renders when a page is registered or cleared. */
export function useAdminPages(): AdminPageEntry[] {
  return useSyncExternalStore(
    adminPageRegistry.subscribe,
    adminPageRegistry.list,
    adminPageRegistry.list,
  );
}
