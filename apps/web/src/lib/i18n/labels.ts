/**
 * 标签表的两栖包装。
 *
 * 项目里大量用了 `ROLE_LABEL[role]` / `STATUS_LABEL[status]` 这种常量查表。
 * 把它们改成"取值时翻译"的对象，就能在不改任何调用点的前提下支持双语：
 * 每次读取属性都会按当前语言返回对应文案。
 *
 * 代价是属性不可枚举赋值（只读），这正是标签表该有的语义。
 */

import { t } from './index';

export function labelMap<K extends string>(source: Record<K, string>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(source) as K[]) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: false,
      get: () => t(source[key]),
    });
  }
  return out;
}
