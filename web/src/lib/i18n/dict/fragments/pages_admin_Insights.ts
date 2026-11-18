import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/pages/admin/Insights.tsx`
 *
 * 只收录本页新增的键：`7 天` / `30 天` / `统计时间范围` / `桌面` / `手机` / `平板` /
 * `更新中` / `服务端统计` / `{count} 次` / `{count} 天` / `重试` / `请求失败。` 等
 * 已经由既有片段提供，重复定义只会增加覆盖顺序上的意外，所以这里不再重复。
 */
const fragment: Dictionary = {
  // ---- 页头与范围 ----
  访问洞察: 'Insights',
  '访客从哪里来、用什么设备、会不会再回来。':
    'Where visitors come from, which devices they use, and whether they return.',

  // ---- 读取状态 ----
  无法读取访问统计: 'Cannot load analytics',
  正在读取访问统计: 'Loading analytics',
  当前后端不支持统计: 'This backend does not support analytics',
  '统计端点未部署或版本过旧；升级后端后，这里会显示来源、设备与留存。':
    'The analytics endpoint is not deployed or is out of date; upgrade the backend to see sources, devices and retention here.',

  // ---- 来源分布 ----
  来源分布: 'Sources',
  '访客从哪里来：直接访问、站内跳转、搜索引擎与外部链接。':
    'Where visits start: direct, internal navigation, search engines and external links.',
  暂无来源数据: 'No source data yet',
  '这个时间范围内还没有访问数据。': 'No visit data in this time range yet.',
  '{visits} 次 · {sessions} 个会话': '{visits} views · {sessions} sessions',
  直接访问: 'Direct',
  站内: 'Internal',
  搜索引擎: 'Search engines',
  社交媒体: 'Social media',
  外部链接: 'External links',
  未知来源: 'Unknown source',

  // ---- 设备分布 ----
  设备分布: 'Devices',
  '访客用什么设备打开站点；机器人单独计数。':
    'The devices visitors use; bots are counted separately.',
  暂无设备数据: 'No device data yet',
  '{count} 个会话': { one: '1 session', other: '{count} sessions' },
  机器人: 'Bots',
  未知设备: 'Unknown device',

  // ---- 来源主机 Top ----
  '来源主机 Top': 'Top source hosts',
  '从其他站点链接进来的访问，按主机名排序。':
    'Visits arriving from other sites, ranked by host.',
  '{count} 个主机': { one: '1 host', other: '{count} hosts' },
  暂无外部来源: 'No external sources yet',
  '还没有从其他站点链接进来的访问。': 'No visits have arrived from other sites yet.',
  来源主机: 'Source host',
  访问数: 'Visits',

  // ---- 留存 ----
  留存: 'Retention',
  '按天拆分新访客会话与回访会话；数字来自服务端会话去重。':
    'New and returning sessions per day, deduplicated on the server.',
  暂无留存数据: 'No retention data yet',
  '这个时间范围内的数据还不足以计算留存。':
    'There is not enough data in this time range to compute retention.',
  每日新会话与回访会话: 'Daily new and returning sessions',
  新会话数: 'New sessions',
  回访会话数: 'Returning sessions',
  日期: 'Date',
  '{date}：新会话 {newSessions}，回访会话 {returningSessions}':
    '{date}: {newSessions} new, {returningSessions} returning',
};

export default fragment;
