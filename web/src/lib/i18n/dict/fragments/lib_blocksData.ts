import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/blocksData.ts` */
const fragment: Dictionary = {
  // 属性面板「显示什么数据」下拉里的数据源名称
  文章标题: 'Article title',
  文章摘要: 'Article summary',
  作者: 'Author',
  发布时间: 'Published at',
  // 与后台列表保持同一译法，避免同名键在不同片段里出现两种英文。
  更新时间: 'Updated',
  分类: 'Category',
  标签: 'Tag',
  阅读时长: 'Reading time',
  阅读量: 'Views',
  文章地址: 'Article URL',
  站点名: 'Site name',
  当前年份: 'Current year',
};

export default fragment;
