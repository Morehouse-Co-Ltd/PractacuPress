import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/builder/BlockInspector.tsx` */
const fragment: Dictionary = {
  // ---- 空状态与面板标题 ----
  '在左侧或预览里选中一个区块，这里会出现它的属性。':
    'Select a block on the left or in the preview to see its properties here.',
  区块属性: 'Block properties',
  '位于「{title}」内': 'Inside “{title}”',

  // ---- 基本字段 ----
  '后台显示名': 'Admin label',
  '只影响编排器里的识别，不改变前台内容。':
    'Only affects how the orchestrator identifies this block; the public site stays the same.',
  入场动画: 'Entrance animation',
  无动画: 'No animation',
  淡入: 'Fade in',
  上浮淡入: 'Fade up',
  左侧滑入: 'Slide in from left',
  右侧滑入: 'Slide in from right',
  缩放进入: 'Zoom in',
  预览动画: 'Preview animation',
  富文本编辑: 'Edit rich text',

  // ---- 落位 ----
  所在栏: 'Column',
  '第 {index} 栏': 'Column {index}',
  卡片布局落位: 'Card layout placement',
  '只在双栏、卡片等分栏布局下生效。': 'Only applies in two-column and other split card layouts.',
  整幅: 'Full width',
  主栏: 'Main column',
  侧栏: 'Sidebar',

  // ---- 尺寸与样式 ----
  组件宽度: 'Block width',
  '0 表示自动；也可以直接拖预览右下角。':
    '0 means auto; you can also drag the bottom-right corner of the preview.',
  最小高度: 'Minimum height',
  '0 表示由内容撑开。': '0 means the height follows the content.',
  '组件 CSS': 'Block CSS',
  '只写声明，例如 padding: 24px; border: 1px solid var(--line); 只作用于当前组件，可复制到其他组件复用。':
    'Declarations only, for example padding: 24px; border: 1px solid var(--line); applies to this block only, and can be copied to other blocks.',
  在页面中隐藏: 'Hide on page',

  // ---- 子区块与删除 ----
  分栏内容: 'Column content',
  '共 {count} 个子区块。直接在左侧把组件拖进对应栏，或用栏位里的“文本/分栏”按钮添加。': {
    one: '1 child block. Drag a component into the column on the left, or add one with the “Text / Columns” buttons in the column.',
    other:
      '{count} child blocks. Drag components into the matching column on the left, or add them with the “Text / Columns” buttons in the column.',
  },
  删除区块: 'Delete block',

  // ---- 2026-11-01 组件外观 ----
  组件外观: 'Block appearance',
  清除外观: 'Reset appearance',
  '作用在组件最外层；要让图片或子组件也一起切角，再打开「裁剪」。':
    'Applies to the outer block box; turn on “Crop” as well to clip images and child blocks to the rounded corners.',
  阴影: 'Shadow',
  '跟随明暗主题的柔和投影；「强调光晕」用站点主色。':
    'A soft shadow that follows the light/dark theme; “Accent glow” uses the site accent colour.',
  '裁剪溢出内容，或按比例裁成相框；文字型组件慎用固定比例。':
    'Clip overflowing content, or crop the block to a fixed aspect ratio; avoid fixed ratios for text-heavy blocks.',
  内边距: 'Padding',
  '单位 px，0 表示不额外留白；配合背景色可以把组件做成卡片。':
    'In px; 0 adds no extra space. Together with a background colour this makes the block look like a card.',
  背景色: 'Background colour',
  '为空表示透明。配合内边距可以把组件做成卡片。':
    'Empty means transparent. Together with padding this makes the block look like a card.',
  组件背景色: 'Block background colour',
  透明: 'Transparent',
  清除: 'Clear',
  主题描边: 'Theme border',
  '用主题的细分割线颜色描一圈边框。': 'Draws a hairline border in the theme divider colour.',

  // ---- 2026-11-03 设备覆盖层 ----
  已覆盖: 'Overridden',
  恢复继承: 'Restore inherited',
  '只改这一台设备；其他设备保持原样。': 'Editing this device only; the others stay unchanged.',
  '已覆盖：只对这一台设备生效。': 'Overridden: applies to this device only.',

  // ---- 2026-11-03 栅格占位 ----
  栅格占位: 'Grid placement',
  占位栏数: 'Column span',
  '最多 12 栏；与偏移冲突时先退偏移，栏数优先。':
    'Up to 12 columns; when it clashes with the offset, the offset moves back first so the span is kept.',
  起始列偏移: 'Column offset',
  '0 表示从第一栏开始；放不下时自动前移。':
    '0 starts at the first column; it moves back automatically when the span does not fit.',
  水平对齐: 'Horizontal alignment',
  '只对这一格生效；「跟随内容」用组件自己的对齐设置。':
    'Applies to this grid cell only; “Follow content” keeps the block’s own alignment.',
  跟随内容: 'Follow content',
  左对齐: 'Left',
  居中: 'Center',
  右对齐: 'Right',

  // ---- 2026-11-03 P3 锚点 ----
  锚点: 'Anchor',
  '只用小写字母、数字与连字符，最多 40 个字符；留空表示这个区块没有锚点。':
    'Lowercase letters, digits and hyphens only, up to 40 characters; leave it empty to give this block no anchor.',
  '链接地址：#{anchor}；重复的锚点只有第一个生效。':
    'Link target: #{anchor}; when anchors repeat, only the first one counts.',
};

export default fragment;
