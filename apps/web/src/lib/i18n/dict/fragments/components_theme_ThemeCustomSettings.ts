import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/theme/ThemeCustomSettings.tsx` */
const fragment: Dictionary = {
  '这套主题提供自己的设置': 'This theme brings its own settings',
  '字段由主题自带的 admin/tabs.json 声明，保存后随站点设计同步到服务端。':
    'The fields are declared by the theme’s admin/tabs.json; saved values travel with the site design to the server.',
  '主题选择放弃内置的主题设置，这一页使用它自己的设置界面。':
    'This theme opts out of the built-in theme settings and uses its own settings interface here.',
  '{count} 项': { one: '1 field', other: '{count} fields' },
  恢复主题默认设置: 'Restore theme defaults',
  '设置保存在站点设计里，不写入服务端环境变量。':
    'Settings live in the site design, not in server environment variables.',
  '{field}的色值': 'Color value for {field}',
};

export default fragment;
