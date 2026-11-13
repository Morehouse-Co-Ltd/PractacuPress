import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/SiteChrome.tsx` */
const fragment: Dictionary = {
  // ---- 页头：品牌与导航 ----
  '{site} 首页': '{site} home',
  快捷链接: 'Shortcuts',
  主导航: 'Main navigation',
  '{name} 二级导航': '{name} sub-navigation',
  返回首页: 'Back to home',
  载入中: 'Loading',

  // ---- 登录后的页头动作 ----
  写文章: 'Write a post',
  新建文章: 'New article',
  通知: 'Notifications',
  '通知，{count} 条未读': {
    one: 'Notifications, 1 unread',
    other: 'Notifications, {count} unread',
  },
  '（{count}）': '({count})',
  私信: 'Messages',
  个人主页: 'Profile',
  我的互动: 'My activity',
  管理后台: 'Admin',
  退出登录: 'Sign out',
  演示数据: 'Demo data',

  // ---- 未登录时的入口 ----
  管理员登录: 'Admin sign-in',
  登录: 'Sign in',
  注册: 'Sign up',
  开始使用: 'Get started',

  // ---- 主题与移动端菜单按钮 ----
  切换到浅色模式: 'Switch to light mode',
  切换到深色模式: 'Switch to dark mode',
  '浅色模式（Shift+D）': 'Light mode (Shift+D)',
  '深色模式（Shift+D）': 'Dark mode (Shift+D)',
  打开菜单: 'Open menu',

  // ---- 公告 ----
  关闭公告: 'Dismiss announcement',

  // ---- 页脚 ----
  公开浏览: 'Public',
  审核发布: 'Review required',
  个人博客: 'Personal blog',
  '（还没有条目）': '(No entries yet)',
  '© {year} {site}. 由写作者与读者共同维护。':
    '© {year} {site}. Maintained by writers and readers.',
};

export default fragment;
