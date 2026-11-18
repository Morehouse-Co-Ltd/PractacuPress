import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/builder/BlockProps.tsx` */
const fragment: Dictionary = {
  '最多 {count} 条。': { one: 'Up to 1 item.', other: 'Up to {count} items.' },
  '添加{label}': 'Add {label}',
  '{label} 第 {index} 条 {field}': '{label} item {index} {field}',
  '这个组件类型已不存在，删除它再添加新的。':
    'This block type no longer exists. Delete it and add a new one.',
  '这个组件没有可配置的属性。': 'This block has no configurable properties.',
  // ---- 组件文字「显示什么数据」 ----
  显示什么数据: 'What data to show',
  自定义文字: 'Custom text',
  收起预览: 'Hide preview',
  '由数据自动填充，回到「自定义文字」可以手改。':
    'Filled in automatically from data; switch back to “Custom text” to edit it by hand.',
};

export default fragment;
