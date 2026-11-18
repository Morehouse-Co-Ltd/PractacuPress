import type { Dictionary } from '../../plural';

/**
 * 前端扩展运行时的英文文案。
 *
 * 来源：
 * - `components/AdminShell.tsx`（「扩展页面」导航分组）
 * - `components/AdminExtensionPage.tsx`（扩展页容器与 404 / 错误边界）
 * - `pages/admin/SystemMonitor.tsx`（「由内置扩展注册」徽标）
 * - `lib/extensions/builtinCatalog.ts` 的性能面板描述（模块级目录，读取时翻译）
 */
const fragment: Dictionary = {
  // ---- 导航 ----
  '扩展页面': 'Extension pages',

  // ---- 内置性能扩展 ----
  '由内置扩展注册': 'Registered by a built-in extension',
  '本软件与其他软件的 CPU、内存、磁盘占用；进程归属、数据目录拆分与实时圆环。':
    'CPU, memory and disk usage of this software versus other software; process ownership, data directory breakdown and live gauges.',

  // ---- 扩展页面容器 ----
  '扩展页面不存在': 'Extension page not found',
  '没有扩展注册路径为 /admin/ext/{slug} 的页面，它可能已被停用或卸载。':
    'No extension registered a page at /admin/ext/{slug}; it may have been disabled or removed.',
  '页面地址只对当前已注册的扩展有效；扩展重新启用后刷新即可恢复。':
    'Page addresses only work while their extension is registered; refresh after re-enabling the extension to restore it.',
  '返回管理后台': 'Back to admin',
  '扩展页面渲染失败': 'The extension page failed to render',
  '扩展 {id} 的页面在渲染时出错，管理后台的其它页面不受影响。':
    'The page from extension {id} failed while rendering; the rest of the admin is unaffected.',
};

export default fragment;
