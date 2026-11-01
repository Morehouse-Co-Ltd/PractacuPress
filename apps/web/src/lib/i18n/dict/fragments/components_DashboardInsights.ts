import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/DashboardInsights.tsx` */
const fragment: Dictionary = {
  // ---- 时间范围 ----
  '7 天': '7 days',
  '30 天': '30 days',

  // ---- 访问统计 ----
  访问记录: 'Traffic',
  '站点前台的访问趋势、来源页面与最近记录。':
    'Traffic trends, referring pages and recent visits from the public site.',
  更新中: 'Updating',
  服务端统计: 'Counted on the server',
  本机统计: 'Counted in this browser',
  统计时间范围: 'Statistics time range',
  浏览量: 'Page views',
  独立会话: 'Unique sessions',
  同一浏览器会话去重: 'Deduplicated per browser session',
  实时在线: 'Online now',
  '最近 5 分钟': 'Last 5 minutes',
  '{range} 访问量': '{range} page views',
  '{range} 访问量折线图': '{range} page views line chart',
  '{label} · {count} 次': '{label} · {count} views',

  // ---- 榜单与最近访问 ----
  热门页面: 'Top pages',
  '{count} 个': { one: '1 page', other: '{count} pages' },
  '这个时间范围内还没有访问。': 'No visits in this time range yet.',
  '{count} 次': { one: '1 view', other: '{count} views' },
  最近访问: 'Recent visits',
  '最新 6 条': 'Latest 6',
  '打开站点前台后，这里会出现访问记录。': 'Open the public site and visits will appear here.',

  // ---- 热门文章 ----
  热门文章: 'Popular articles',
  '按文章详情页阅读次数排序。': 'Ranked by reads on the article page.',
  还没有文章: 'No articles yet',
  '发布内容后，这里会出现热门文章。':
    'Popular articles will appear here once you publish something.',

  // ---- 最近文章 ----
  最近文章: 'Recent articles',
  '按发布时间倒序。': 'Newest first.',
  '发布内容后，这里会出现最近文章。':
    'Recent articles will appear here once you publish something.',
};

export default fragment;
