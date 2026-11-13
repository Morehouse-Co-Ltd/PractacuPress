import type { Dictionary } from '../../plural';

/**
 * 扩展管理页（服务器扩展横条列表 + 右侧详情 + zip 导入 / 启停 / 删除）的英文文案。
 *
 * 来源：`apps/web/src/pages/admin/Extensions.tsx` 的新管理区。
 * 原有「内置扩展开关 / 创作者扩展」区块的文案仍留在 `pages_admin_Extensions.ts`，
 * 这里只补新文案，避免同一个词两种译法（导入、删除、启用、内置等直接复用旧词条）。
 */
const fragment: Dictionary = {
  // ---- 页头 ----
  '服务器扩展以 zip 安装包导入，由后端启动清单决定是否运行；内置扩展随应用发布，免安装。下方保留原有的内置前台扩展开关与创作者扩展管理。':
    'Server extensions are installed from a zip package and run only when the backend boot manifest says so; built-in extensions ship with the app and need no install. The original built-in front-end switches and creator extensions are kept below.',
  '扩展文档': 'Extension docs',

  // ---- 列表 ----
  '服务器扩展': 'Server extensions',
  '服务器扩展与内置扩展都在左侧列表里；点击一行在右侧查看介绍、权限与前后端能力。':
    'Server and built-in extensions share the list on the left; select a row to see its description, permissions and front-end / back-end abilities on the right.',
  '共 {count} 个扩展': { one: '1 extension', other: '{count} extensions' },
  '仅平台管理员可管理服务器扩展':
    'Only platform administrators can manage server extensions',
  '服务器扩展包的导入、启用与删除需要平台管理员；内置扩展与下方的创作者扩展仍可正常使用。':
    'Importing, enabling and deleting server extension packages requires a platform administrator; built-in extensions and the creator extensions below still work normally.',
  '演示模式没有服务器扩展': 'Demo mode has no server extensions',
  '演示数据只存在浏览器里，没有安装服务；连接真实后端后可以导入、启用或删除扩展包。这里只显示随应用发布的内置扩展。':
    'Demo data lives only in the browser and there is no install service. Connect a real backend to import, enable or delete extension packages. Only the built-in extensions shipped with the app are listed here.',
  '服务器扩展接口未就绪': 'Server extension API is not ready',
  '当前后端还没有提供扩展管理 API（/api/v1/extensions）。页面先展示随应用发布的内置扩展；后端就绪后点「刷新」重新读取。':
    'The current backend does not provide the extension management API (/api/v1/extensions) yet. Built-in extensions are listed first; press Refresh once the backend is ready.',
  '读取服务器扩展失败': 'Could not read server extensions',
  '正在读取服务器扩展…': 'Reading server extensions…',
  '正在导入扩展包…': 'Importing extension package…',
  '导入扩展包失败': 'Could not import the extension package',
  '还没有安装服务器扩展；导入一个 zip 扩展包即可。':
    'No server extensions installed yet; import a zip extension package to add one.',
  '查看「{name}」的详细信息': 'Show details for “{name}”',
  '启用或禁用「{name}」': 'Enable or disable “{name}”',
  '始终启用': 'Always on',
  '前端': 'Front end',
  '后端': 'Back end',
  '全栈': 'Full stack',
  '运行失败': 'Failed',
  '已安装': 'Installed',

  // ---- 详情 ----
  '服务器扩展详情': 'Server extension details',
  '选择一个扩展查看详细信息。': 'Select an extension to see its details.',
  '最近一次错误': 'Most recent error',
  '许可': 'License',
  '主页': 'Homepage',
  '运行时': 'Runtime',
  '安装时间': 'Installed at',
  '启用时间': 'Enabled at',
  '前端能力': 'Front-end abilities',
  '后端能力': 'Back-end abilities',
  '入口': 'Entry',
  '区块': 'Blocks',
  '路由': 'Routes',
  '钩子': 'Hooks',
  '超时': 'Timeout',
  '内存上限': 'Memory limit',
  '没有声明权限。': 'No permissions declared.',
  '内置扩展，随应用发布': 'Built-in extension, shipped with the app',
  '打开扩展页面 →': 'Open the extension page →',
  '仅平台管理员可启用、禁用或删除服务器扩展。':
    'Only platform administrators can enable, disable or delete server extensions.',
  '服务器扩展以 zip 安装包导入，由后端启动清单决定是否运行；内置扩展随应用发布，免安装。点击一行在右侧查看介绍、权限与前后端能力。':
    'Server extensions are installed from zip packages and run according to the backend boot manifest; built-in extensions ship with the app and need no installation. Click a row to inspect its description, permissions and front/back-end capabilities on the right.',
  '服务器扩展包的导入、启用与删除需要平台管理员；内置扩展仍可正常查看。':
    'Importing, enabling or deleting server extension packages requires a platform administrator; built-in extensions stay visible.',

  // ---- 删除确认与提示 ----
  '确定删除服务器扩展「{name}」吗？': 'Delete the server extension “{name}”?',
  '删除后扩展目录会从服务器移除；内置扩展不受影响。':
    'Deleting removes the extension directory from the server; built-in extensions are unaffected.',
  '服务器扩展已删除': 'Server extension deleted',
  '删除扩展失败': 'Could not delete the extension',
  '扩展包已导入': 'Extension package imported',
  '切换启用状态失败': 'Could not change the enabled state',
  '是否运行由后端启动清单决定，刷新页面后生效。':
    'Whether it actually runs is decided by the backend boot manifest; refresh the page for it to take effect.',
};

export default fragment;
