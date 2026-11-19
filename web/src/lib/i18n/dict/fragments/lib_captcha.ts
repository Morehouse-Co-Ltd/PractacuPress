import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/captcha.ts` */
const fragment: Dictionary = {
  '请先完成人机验证。': 'Please complete the human verification first.',
  '人机验证没有通过，请重新验证后再试。':
    'Human verification did not pass. Please try again.',
  '这次验证已经用过了，请重新验证。':
    'This verification was already used. Please verify again.',
  '人机验证服务暂时连不上，请稍后重试。':
    'The verification service is unreachable right now. Please try again shortly.',
  '站点暂时无法读取验证设置，请稍后重试。':
    'The site cannot read its verification settings right now. Please try again shortly.',
};

export default fragment;
