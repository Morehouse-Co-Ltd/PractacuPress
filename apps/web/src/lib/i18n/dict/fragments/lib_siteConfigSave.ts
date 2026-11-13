import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/lib/siteConfigSave.ts` */
const fragment: Dictionary = {
  '设置没有保存到服务端': 'Settings were not saved to the server',
  '本机已更新，但服务端拒绝或暂时不可用（{reason}）。刷新页面会回到服务端保存的版本。':
    'This browser is updated, but the server refused the write or is temporarily unavailable ({reason}). Reloading returns to the version saved on the server.',
  '本机已更新，但服务端拒绝或暂时不可用。刷新页面会回到服务端保存的版本。':
    'This browser is updated, but the server refused the write or is temporarily unavailable. Reloading returns to the version saved on the server.',
};

export default fragment;
