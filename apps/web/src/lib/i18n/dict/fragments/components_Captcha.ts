import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/Captcha.tsx` */
const fragment: Dictionary = {
  '验证组件没有就绪。请刷新页面后重试。':
    'The verification widget is not ready. Refresh the page and try again.',
  '人机验证组件运行失败，请刷新页面重试。':
    'The verification widget failed to run. Refresh the page and try again.',
  '验证组件没能加载。请检查网络或关闭拦截扩展后刷新页面；如果一直失败，请联系站长。':
    'The verification widget could not load. Check the network or disable blocking extensions, then refresh; contact the site owner if it keeps failing.',
  '受本站人机验证保护。': 'Protected by this site’s human verification.',

  // ---- 本地（自托管）算术验证 ----
  '本站没有启用本地人机验证。': 'This site does not run the local human check.',
  '正在获取验证题…': 'Fetching a verification question…',
  '请回答下面的算术题，证明你是真人：': 'Answer the arithmetic question below to prove you are human:',
  答案: 'Answer',
  验证答案: 'Verification answer',
  验证: 'Verify',
  换一题: 'New question',
  已验证: 'Verified',
  '已完成本地人机验证。': 'Local human verification complete.',
  '请填写整数答案。': 'Enter a whole number.',
  '答案不正确或已过期，请重新作答。':
    'The answer was wrong or expired. Please answer the new question.',
  '验证题加载失败，请刷新页面后重试。':
    'The verification question could not load. Refresh the page and try again.',
};

export default fragment;
