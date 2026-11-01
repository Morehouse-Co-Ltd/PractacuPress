import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/builder/BlockInspector.tsx` */
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
  夜航布局落位: 'Nightflight placement',
  '只在夜航（bento）布局下生效。': 'Only applies in the Nightflight (bento) layout.',
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
};

export default fragment;
