import { t } from './index';

/**
 * 让模块级目录（主题、区块、图标……）里的中文跟着语言变化。
 *
 * 背景：`export const DEFS = [{ name: t('中文') }]` 里的 `t()` 在 **import 时**
 * 就求值了，那时语言还是默认的简体中文；之后在设置里切到英文，这些常量不会重算，
 * 页面就会一直是中文。
 *
 * 而中文原文就是翻译键，所以中文下 `t()` 得到的值恰好就是键本身。于是可以把这些
 * 字符串换成 getter：读取时再翻译一次，目录就能实时跟随语言，调用方一个字都不用改。
 *
 * 只处理含中日韩字符的字符串——type id、CSS 值、十六进制色值、枚举字面量原样保留。
 * 需要排除的子树（例如区块的 `defaults`，它是会被持久化的初始内容）用 `skip` 指定。
 */

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export interface LiveCatalogOptions {
  /** 这些属性名下的东西是持久化数据，既不改写也不下钻。 */
  skip?: string[];
}

export function liveCatalog<T>(value: T, options: LiveCatalogOptions = {}): T {
  visit(value, new Set(options.skip ?? []));
  return value;
}

function visit(node: unknown, skip: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, skip);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue;
    const raw = (node as Record<string, unknown>)[key];
    if (typeof raw === 'string') {
      if (!CJK.test(raw)) continue;
      try {
        Object.defineProperty(node, key, {
          enumerable: true,
          configurable: true,
          get: () => t(raw),
        });
      } catch {
        // 冻结对象之类改不了就保持原值：宁可少翻一处，也不要开机就崩。
      }
      continue;
    }
    visit(raw, skip);
  }
}
