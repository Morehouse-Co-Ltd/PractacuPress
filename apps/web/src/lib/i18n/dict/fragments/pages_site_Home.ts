import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Home.tsx` */
const fragment: Dictionary = {
  // ---- 读取失败 ----
  '无法读取内容': 'Could not load content',
  '这个站点设置为「登录后浏览」，请先登录。':
    'This site is set to members only. Please sign in first.',
  '请求失败。': 'Request failed.',
  去登录: 'Go to sign in',
  // `重试` 已在 dict/common.ts 定义（Retry），此处不重复。
};

export default fragment;
