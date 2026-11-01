import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Loading.tsx` */
const fragment: Dictionary = {
  '主题设置': 'Theme settings',
  '加载动画': 'Loading animation',
  '站点管理员': 'Site admin',
  '加载动画已保存': 'Loading animation saved',
  '前台刷新或切换页面时会按设置显示。':
    'It shows up as configured when the site is refreshed or pages change.',
  '加载动画当前关闭。': 'The loading animation is currently off.',
  '已恢复默认加载动画': 'Default loading animation restored',
  '加载画面关闭，图形回到圆环。': 'The loading screen is off and the shape is back to the ring.',
  '全屏预览': 'Full-screen preview',
  '加载动画只在站点前台出现': 'The loading animation only appears on the public site',
  '制作站点首次加载或切换页面时的等待画面。图形、颜色、背景、尺寸与最短展示时长都可以':
    'Build the wait screen for the first load or for switching pages. Shape, color, background, size, and the minimum display time are all',
  '调整；管理后台和页面编排预览不会显示，避免影响日常编辑。':
    'adjustable; the dashboard and layout previews never show it, so day-to-day editing stays unaffected.',
  '这是站点前台的第一印象': 'This is the first impression of the public site',
  '加载画面只在真正等待时出现。最短展示时长最多 3 秒；如果站长把「切换页面」也打开，':
    'The loading screen appears only during a real wait. The minimum display time is at most 3 seconds; if the owner also turns on “switching pages”,',
  '每次站内导航都会停留这么久，请先用预览确认体感。':
    'every in-site navigation lingers that long, so check how it feels in the preview first.',
  '图形': 'Shape',
  '选择一个预设；预览和真实前台使用同一套 CSS。':
    'Pick a preset; the preview and the live site share the same CSS.',
  '已启用': 'Enabled',
  '未启用': 'Not enabled',
  '启用站点加载动画': 'Enable the site loading animation',
  '只在前台出现；后台、安装向导与编排预览始终不显示。':
    'Public site only; the dashboard, setup wizard, and layout previews never show it.',
  '文案与配色': 'Copy and colors',
  '强调色和背景可以跟随主题，也可以单独指定。':
    'Accent and background can follow the theme or be set on their own.',
  '重播预览': 'Replay preview',
  '加载文案': 'Loading text',
  '留空只显示图形。': 'Leave empty to show only the shape.',
  '强调色': 'Accent color',
  '跟随主题': 'Follow theme',
  '自定义': 'Custom',
  '加载动画强调色': 'Loading animation accent color',
  '背景': 'Background',
  '加载动画背景色': 'Loading animation background color',
  '图形尺寸': 'Shape size',
  '最短展示': 'Minimum display',
  '避免加载一闪而过；最多 3000 ms。':
    'Keeps the load from flashing by; 3000 ms at most.',
  '首次打开站点时显示': 'Show on the first visit to the site',
  '站内切换页面时显示': 'Show when switching pages on the site',
  '每次导航都会停留最短展示时长，开启前请确认体感。':
    'Every navigation lingers for the minimum display time, so check how it feels before turning this on.',
  '两个显示场景都关闭了，加载动画实际上不会出现。':
    'Both display cases are off, so the loading animation never actually appears.',
  '实时预览': 'Live preview',
  '使用当前站点的真实主题色模拟前台。':
    'Simulates the public site with the current theme colors.',
  '预览会像真实加载层一样循环播放；点击「全屏预览」可以看到铺满屏幕的效果。':
    'The preview loops like the real loading layer; click “Full-screen preview” to see it fill the screen.',
  '附加 CSS': 'Extra CSS',
  '只作用于加载画面，不会进入后台。':
    'Applies to the loading screen only and never reaches the dashboard.',
  '{count} 字符': { one: '1 character', other: '{count} characters' },
  '未使用': 'Not used',
  '加载动画 CSS': 'Loading animation CSS',
  '可用类名：': 'Available class names: ',
  '、': ', ',
  '。只粘贴自己信任的 CSS。': '. Only paste CSS you trust.',
  '当前设置': 'Current settings',
  '保存后才在前台生效。': 'Takes effect on the public site after saving.',
  '首次加载': 'First load',
  '切换页面': 'Switch pages',
  '显示': 'Shown',
  '不显示': 'Hidden',
  '管理后台与编排预览不会出现加载画面；如果站点被访问限制拦住，拦截页的层级更高。':
    'The dashboard and layout previews never show the loading screen; if access limits block the site, the block page takes precedence.',
  '恢复默认加载动画': 'Restore the default loading animation',
  '关闭加载画面并回到圆环、跟随主题、450 ms。不会影响主题与页面。':
    'Turns the loading screen off and returns to the ring, theme colors, and 450 ms. Themes and pages are untouched.',
  '恢复默认': 'Restore defaults',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '只影响站点前台': 'Affects the public site only',
  '关闭预览': 'Close preview',
};

export default fragment;
