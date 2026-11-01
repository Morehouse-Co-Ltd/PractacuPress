import type { Dictionary } from '../plural';
import common from './common';
import curated from './lib';

/**
 * 全部英文文案。
 *
 * 组成方式：
 * - `common.ts`：到处都在用的通用词（保存、取消、删除……），人工维护；
 * - `lib.ts`：非页面模块的标签表（角色、状态、相对时间……），人工维护；
 * - `fragments/*.ts`：按**源文件**拆的译文片段，一个文件一个人负责，迁移可以并行。
 *
 * 用 `import.meta.glob` 把片段合并进来：新增一个片段不需要改这个文件，
 * 也就不会出现多人同时改同一个索引文件的冲突。展开顺序决定覆盖顺序，
 * 片段放最后：具体页面的译法优先于通用词。
 */
const fragments = import.meta.glob<Dictionary>('./fragments/*.ts', {
  eager: true,
  import: 'default',
});

export const DICT: Dictionary = {
  ...common,
  ...curated,
  ...Object.assign({}, ...Object.values(fragments)),
};

export default DICT;
