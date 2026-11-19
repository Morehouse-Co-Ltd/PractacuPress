import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/builder/ChainEditor.tsx` */
const fragment: Dictionary = {
  // ---- 步骤字段 ----
  '选择组件…': 'Choose a block…',
  任意组件: 'Any block',

  // ---- 链条卡片 ----
  '链条 {index}': 'Chain {index}',
  不完整: 'Incomplete',
  就绪: 'Ready',
  删除链条: 'Delete chain',
  链条名称: 'Chain name',
  '只给你自己看，例如“深色时高亮统计卡”。': 'Only you see this, e.g. “highlight the stats card in dark mode”.',
  '还没有步骤。先加一个「当…发生时」。': 'No steps yet. Start with a “When this happens” step.',

  // ---- 步骤种类 ----
  '当…发生时': 'When this happens',
  '如果…': 'if…',
  '就…': 'then…',
  删除步骤: 'Delete step',

  // ---- 添加步骤 ----
  添加步骤: 'Add step',
  添加触发步骤: 'Add trigger step',
  添加条件步骤: 'Add condition step',
  添加动作步骤: 'Add action step',

  // ---- 编辑器外壳 ----
  '新链条 {index}': 'New chain {index}',
  '思维链是纯数据，不是脚本': 'Logic chains are pure data, not scripts',
  '一条链 = 触发 + 条件 + 动作。运行时只读这份配置，不执行任何动态代码，因此不会更慢也不会有注入面。':
    'A chain = trigger + condition + action. At runtime the site only reads this configuration and never runs dynamic code, so it is neither slower nor an injection surface.',
  '每条链触发后有 1.5 秒冷却，避免滚动或悬停把动作放成刷屏。':
    'Each chain has a 1.5 second cooldown after it fires, so scrolling or hovering cannot turn actions into a flood.',
  '还没有思维链。例如：滚到 60% 时闪烁一次统计卡；切到深色时显示作者卡。':
    'No chains yet. For example: pulse the stats card once at 60% scroll; show the author card when the site turns dark.',
  新建思维链: 'New chain',
  再建一条: 'Add another',
  '最多 20 条。': 'Up to 20 chains.',
};

export default fragment;
