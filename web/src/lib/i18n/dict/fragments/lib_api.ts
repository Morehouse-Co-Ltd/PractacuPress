import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/api.ts` */
const fragment: Dictionary = {
  // ---- HTTP 状态码兜底文案（fallbackProblem） ----
  '请求没有通过校验。': 'The request did not pass validation.',
  '登录状态已失效，请重新登录。': 'Your session has expired. Please sign in again.',
  '当前账户没有执行此操作的权限。': 'Your account is not allowed to do this.',
  '资源不存在，或不在当前站点内。': 'The resource does not exist, or is not in this site.',
  '资源状态已变化，请刷新后重试。': 'The resource changed. Refresh and try again.',
  '操作过于频繁，请稍后再试。': 'Too many requests. Please try again later.',
  '安全服务暂不可用，操作已被暂存。': 'The security service is unavailable; the action has been queued.',
  '服务暂时不可用。': 'The service is temporarily unavailable.',

  // ---- 连接与上传 ----
  '无法连接 API': 'Cannot reach the API',
  '无法连接 {origin}，请确认服务已启动。': 'Cannot reach {origin}. Check that the service is running.',
  '连接失败': 'Connection failed',
  '上传过程中断，请重试。': 'The upload was interrupted. Please try again.',
};

export default fragment;
