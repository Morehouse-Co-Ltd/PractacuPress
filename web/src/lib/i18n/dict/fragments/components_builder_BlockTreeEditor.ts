import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/builder/BlockTreeEditor.tsx` */
const fragment: Dictionary = {
  // ---- 组件库 ----
  组件: 'Blocks',
  '点击追加，或拖到画布/分栏里。': 'Click to append, or drag it onto the canvas or into a column.',
  布局: 'Layout',
  媒体: 'Media',
  数据与代码: 'Data & code',
  内容: 'Content',
  主题组件: 'Theme components',

  // ---- 结构树 ----
  页面结构: 'Page structure',
  '{count} 个区块': { one: '1 block', other: '{count} blocks' },
  ' · 已选「{title}」': ' · Selected “{title}”',
  '还没有区块。从上方组件库点击添加，或把组件拖进来。':
    'No blocks yet. Add one from the palette above, or drag a block in.',
  '已达到 200 个区块上限，删除一些再添加。':
    'You have reached the 200-block limit. Delete some blocks before adding more.',

  // ---- 区块行 ----
  展开子组件: 'Expand child blocks',
  收起子组件: 'Collapse child blocks',
  '{count} 子项': { one: '1 child', other: '{count} children' },
  已隐藏: 'Hidden',
  上移: 'Move up',
  下移: 'Move down',
  显示: 'Show',
  隐藏: 'Hide',

  // ---- 分栏与投放 ----
  '第 {index} 栏': 'Column {index}',
  '拖入第 {index} 栏': 'Drop into column {index}',
  子组件: 'Child blocks',
  文本: 'Text',
  分栏: 'Columns',
  容器: 'Container',
  拖到这里: 'Drop here',
  拖到这里排序: 'Drop here to reorder',
  拖到页面末尾: 'Drop at the end of the page',
};

export default fragment;
