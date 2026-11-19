import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/ExtensionStudio.tsx` */
const fragment: Dictionary = {
  // ---- 预览失败与回退 ----
  '扩展预览失败': 'Extension preview failed',
  '预览失败': 'Preview failed',
  '预览已回退到上次保存的版本；表单内容不受影响，仍然可以保存。':
    'The preview went back to the last saved version; the form is unaffected and you can still save.',
  '预览脚本没有跑起来；表单内容不受影响，仍然可以保存。':
    'The preview script did not start; the form is unaffected and you can still save.',
  '已回退到上次保存的版本。': 'Showing the last saved version.',
  '未保存的改动仍然在左侧表单里，修好之后会自动重新预览。':
    'Your unsaved edits are still in the form on the left; the preview returns as soon as they render again.',
  '还没有 HTML / CSS / JS 内容': 'No HTML / CSS / JS content yet',

  // ---- 编辑状态 ----
  '未保存的修改': 'Unsaved changes',
  '放弃修改': 'Discard changes',
  '导出草稿清单': 'Export draft manifest',

  // ---- 代码字段 ----
  'HTML 正文': 'HTML body',
  'CSS 样式': 'CSS',
  'JS 脚本': 'JavaScript',
  '预览页类型': 'Preview page',
  '示例模板会覆盖当前的 HTML / CSS / JS，继续吗？':
    'A sample template replaces the current HTML / CSS / JS. Continue?',
  '继续': 'Continue',
};

export default fragment;
