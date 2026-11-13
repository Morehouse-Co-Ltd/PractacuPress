import type { IconName } from '../../components/Icon';

/**
 * 内置扩展目录（前端）。
 *
 * 这些扩展的代码直接编译在应用里，但它们和导入的扩展走同一条「扩展注册」通道：
 * 注册页面、注册导航、在「扩展」页里作为一行出现。这样“性能面板是扩展的内容”
 * 不是一句口号，而是同一个运行时。
 *
 * 显示名与描述保持中文原文，渲染时用 `t()` 翻译（与 blockDef 的约定一致）。
 */
export interface BuiltinExtensionInfo {
  /** 稳定 id，和导入扩展同一命名空间（内置用 pp. 前缀）。 */
  id: string;
  name: string;
  description: string;
  version: string;
  /** 管理页路径片断：/admin/ext/{pageId}。 */
  pageId: string;
  icon: IconName;
  /** 所属导航分组：overview 排在仪表盘下方；extensions 单独一组。 */
  navGroup: 'overview' | 'extensions';
}

export const BUILTIN_EXTENSIONS: BuiltinExtensionInfo[] = [
  {
    id: 'pp.performance',
    name: '性能面板',
    description:
      '本软件与其他软件的 CPU、内存、磁盘占用；进程归属、数据目录拆分与实时圆环。',
    version: '1.0.0',
    pageId: 'system',
    icon: 'activity',
    navGroup: 'overview',
  },
];

/** 按 id 查内置扩展；导入的扩展不应命中。 */
export function builtinExtensionById(id: string): BuiltinExtensionInfo | undefined {
  return BUILTIN_EXTENSIONS.find((item) => item.id === id);
}
