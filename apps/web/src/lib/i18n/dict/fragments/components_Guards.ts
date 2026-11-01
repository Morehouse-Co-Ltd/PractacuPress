import type { Dictionary } from '../../plural';

/** 来源：`src/components/Guards.tsx` */
const fragment: Dictionary = {
  正在确认登录状态: 'Checking your session',
  编辑: 'Edit',
  '需要{need}权限': 'This page requires the {need} permission',
  '当前账户在「{site}」的角色是「{role}」，无法访问这个页面。权限由服务端强制校验，界面隐藏不能替代授权。站长可以在「用户组」里调整这一项。':
    'Your account has the {role} role on “{site}” and cannot open this page. Permissions are enforced by the server, so hiding UI is not authorization. A site admin can adjust this in Groups.',
  本站: 'this site',
  未登录: 'not signed in',
  返回站点: 'Back to site',
  回到后台: 'Back to dashboard',
};

export default fragment;
