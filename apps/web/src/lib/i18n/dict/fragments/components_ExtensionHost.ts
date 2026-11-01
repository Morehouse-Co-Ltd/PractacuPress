import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/ExtensionHost.tsx` */
const fragment: Dictionary = {
  '[扩展 {name}] 未声明 {permission} 权限，已忽略 {type} 请求。':
    '[Extension {name}] Missing the {permission} permission; ignored the {type} request.',
  '[扩展 {name}] 只允许打开 http(s) 链接。': '[Extension {name}] Only http(s) links are allowed.',
  '[扩展 {name}] 只能跳转到站内路径。':
    '[Extension {name}] Only in-site paths can be navigated to.',
};

export default fragment;
