import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/builder/BlockProps.tsx` */
const fragment: Dictionary = {
  '最多 {count} 条。': { one: 'Up to 1 item.', other: 'Up to {count} items.' },
  '添加{label}': 'Add {label}',
  '{label} 第 {index} 条 {field}': '{label} item {index} {field}',
  '这个组件类型已不存在，删除它再添加新的。':
    'This block type no longer exists. Delete it and add a new one.',
  '这个组件没有可配置的属性。': 'This block has no configurable properties.',
};

export default fragment;
