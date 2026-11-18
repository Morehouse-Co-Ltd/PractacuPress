import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/Captcha.tsx`、`web/src/components/LocalCaptcha.tsx` */
const fragment: Dictionary = {
  '验证组件没有就绪。请刷新页面后重试。':
    'The verification widget is not ready. Refresh the page and try again.',
  '人机验证组件运行失败，请刷新页面重试。':
    'The verification widget failed to run. Refresh the page and try again.',
  '验证组件没能加载。请检查网络或关闭拦截扩展后刷新页面；如果一直失败，请联系站长。':
    'The verification widget could not load. Check the network or disable blocking extensions, then refresh; contact the site owner if it keeps failing.',
  '受本站人机验证保护。': 'Protected by this site’s human verification.',

  // ---- 本地（自托管）图形验证：滑块 / 点击 / 选择图形 ----
  '本站没有启用本地人机验证。': 'This site does not run the local human check.',
  '正在获取验证题…': 'Fetching a verification challenge…',
  '验证题加载失败，请刷新页面后重试。':
    'The verification challenge could not load. Refresh the page and try again.',
  '已完成本地人机验证。': 'Local human verification complete.',
  '答案不正确或已过期，请重新作答。':
    'The answer was wrong or expired. Please solve the new challenge.',
  验证: 'Verify',
  换一题: 'New challenge',
  重选: 'Clear selection',

  // 滑块
  '拖动圆形拼图，让它落进图中的缺口，然后点「验证」。':
    'Drag the round piece into the gap in the picture, then choose “Verify”.',
  '拖动滑块调整拼图位置': 'Drag the slider to move the piece',

  // 点击
  '点击图中的所有星星（共 {count} 个），然后点「验证」。':
    'Click every star in the picture ({count} in total), then choose “Verify”.',
  '已选 {selected} / {total} 个': 'Selected {selected} of {total}',

  // 选择图形
  '选择所有包含圆形的图片（共 {count} 张），然后点「验证」。':
    'Select every tile that contains a circle ({count} in total), then choose “Verify”.',
  '已选 {selected} / {total} 张': 'Selected {selected} of {total}',
};

export default fragment;
