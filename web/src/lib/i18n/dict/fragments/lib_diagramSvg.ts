import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/lib/diagramSvg.ts`
 *
 * 空态占位与「没有图题时的无障碍名称」。图题本身是用户内容，不进字典。
 */
const fragment: Dictionary = {
  '暂无图表数据。': 'No chart data yet.',
  '暂无大纲数据。': 'No outline data yet.',
  思维导图: 'Mind map',
  逻辑图: 'Logic diagram',
  统计图: 'Statistics chart',
  鱼骨图: 'Fishbone diagram',
};

export default fragment;
