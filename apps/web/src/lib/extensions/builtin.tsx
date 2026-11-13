import { createElement } from 'react';
import { SystemMonitorPage } from '../../pages/admin/SystemMonitor';
import { liveCatalog } from '../i18n/live';
import { adminPageRegistry } from '../plugins/adminRegistry';
import type { AdminPageDefinition } from '../plugins/types';
import { BUILTIN_EXTENSIONS } from './builtinCatalog';

/**
 * 内置扩展的注册入口。
 *
 * 内置扩展的代码随应用一起编译，但它们和导入的扩展走同一条注册通道：
 * 在 `adminPageRegistry` 里占一个页面，管理后台据此生成导航与路由
 * （`/admin/ext/{pageId}`）。性能面板因此不再是 AdminShell 里写死的一行 nav，
 * 而是 `pp.performance` 这个内置扩展注册的页面。
 *
 * 这个模块在 App.tsx 里以副作用导入，import 即注册；内置扩展始终启用。
 */

const PERFORMANCE_ID = 'pp.performance';

let registered = false;

/** 注册所有内置扩展页面；重复调用（HMR / StrictMode）是安全的空操作。 */
export function registerBuiltinExtensions(): void {
  if (registered) return;
  registered = true;
  // HMR 可能重新执行模块而注册表还是进程单例：已有条目就不要再注册一遍。
  if (adminPageRegistry.list().some((entry) => entry.pluginID === PERFORMANCE_ID)) return;

  const catalog = BUILTIN_EXTENSIONS.find((item) => item.id === PERFORMANCE_ID);
  if (!catalog) return;

  // 目录里存的是中文原文，`liveCatalog` 把 label / description 换成读取时翻译的
  // getter，后台切到英文后导航与面包屑会立刻跟着变（见 i18n/live.ts）。
  const page: AdminPageDefinition = liveCatalog({
    id: catalog.pageId,
    path: catalog.pageId,
    label: catalog.name,
    icon: catalog.icon,
    group: catalog.navGroup,
    order: 0,
    description: catalog.description,
    render: () => createElement(SystemMonitorPage),
  });

  adminPageRegistry.register(PERFORMANCE_ID, page);
}

registerBuiltinExtensions();
