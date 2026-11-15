import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/lib/updateClient.ts` */
const fragment: Dictionary = {
  '还没有选择更新源。': 'No update source is selected yet.',
  '当前服务器不支持服务端检查更新，请用启动器或 npm start 启动站点。':
    'This server does not support server-side update checks; start the site with the launcher or npm start.',
  '无法连接更新源，请检查网络后重试。':
    'Could not reach the update source; check the network and try again.',
  '更新源返回的不是有效的版本清单。': 'The update source did not return a valid version manifest.',
  '更新检查失败，请稍后再试。': 'The update check failed; try again later.',
};

export default fragment;
