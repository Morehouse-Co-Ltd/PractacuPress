import type { Dictionary } from '../plural';
import adminContent from './adminContent';
import adminSite from './adminSite';
import adminTheme from './adminTheme';
import blocks from './blocks';
import common from './common';
import lib from './lib';
import setup from './setup';
import shell from './shell';
import site from './site';

/**
 * 全部英文文案。
 *
 * 按来源拆成若干命名空间，是为了让迁移可以并行：每个命名空间一个文件、
 * 一个人负责，写入范围互不重叠。运行期只是一张扁平的表，查表就是对象属性。
 *
 * 展开顺序 = 覆盖顺序：后面的同名键会盖掉前面的。`common` 放最前面，
 * 业务表里同名键以业务为准（业务更清楚上下文）。
 */
export const DICT: Dictionary = {
  ...common,
  ...lib,
  ...shell,
  ...setup,
  ...adminSite,
  ...adminContent,
  ...adminTheme,
  ...site,
  ...blocks,
};

export default DICT;
