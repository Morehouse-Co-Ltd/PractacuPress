import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/ProtectionLayer.tsx` */
const fragment: Dictionary = {
  切换页面过于频繁: 'Too many page switches',
  '短时间内打开或切换了太多页面。这通常是脚本或自动化访问的特征。':
    'Too many pages were opened or switched in a short time. This is usually a sign of a script or automated access.',
  请求过于频繁: 'Too many requests',
  '站点脚本在短时间内发起了太多请求。为了保护服务器，已暂时停止响应。':
    'The site script sent too many requests in a short time. To protect the server, responses have been paused for now.',
  同时打开的页面过多: 'Too many pages open at once',
  '同一浏览器同时打开了太多站点页面。关闭其他页面后会自动恢复。':
    'This browser has too many site pages open at once. Close the other pages and access resumes automatically.',
  '/ {limit} 个页面': { one: '/ {limit} page', other: '/ {limit} pages' },
  秒后可继续访问: 'seconds until access resumes',
  '关闭其他站点标签页后，本页会自动恢复。':
    'Close the other site tabs and this page resumes automatically.',
  '倒计时结束后会自动恢复；如果页面数据没有加载出来，请重新载入。':
    'Access resumes when the countdown ends. If the page data did not load, reload the page.',
  重新载入: 'Reload',
  进入管理后台: 'Open the dashboard',
  '这是浏览器端保护。服务器与网关仍会按 IP 执行请求与并发限制。':
    'This is browser-side protection. The server and gateway still enforce request and concurrency limits per IP.',
};

export default fragment;
