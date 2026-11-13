import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/SiteUpdate.tsx`、`lib/siteUpdate.ts` */
const fragment: Dictionary = {
  '站点更新': 'Site updates',
  '检查更新': 'Check for updates',
  '保存设置': 'Save settings',
  '更新服务暂未接入': 'Update service is not connected yet',
  '等更新服务端可用后，这里会显示可用的新版本与更新入口。':
    'Once the update service is available, new versions and the update entry will appear here.',
  '在这里查看站点显示名称与当前版本，并决定是否自动检查更新。更新服务端尚未接入，相关地址和端口可以暂时留空，不会影响其它功能。':
    'Review the site display name and current version, and choose whether to check for updates automatically. The update service is not connected yet, so the address and port may stay empty without affecting any other feature.',
  '这一页先提供更新设置入口：当前版本来自前端构建，更新服务端地址与端口可以留空；设置先保存在本机后台配置里。等更新服务上线后，同样的设置会用于检查新版本；在此之前所有功能照常使用。':
    'This page is the update settings entry for now: the current version comes from the frontend build, the update server address and port may stay empty, and settings are saved in the local admin configuration. When the update service ships, these settings will drive version checks; until then everything keeps working.',
  '当前站点': 'Current site',
  '站点显示名称与当前运行的软件版本。': 'The site display name and the software version that is running.',
  '站点显示名称': 'Site display name',
  '未命名站点': 'Untitled site',
  '当前版本': 'Current version',
  '运行模式': 'Run mode',
  '演示模式': 'Demo mode',
  '正式站点': 'Live site',
  '更新服务端': 'Update server',
  '暂未配置': 'Not configured',
  '站点显示名称可在「站点设置 → 基本信息」里修改。':
    'The site display name can be changed under Site settings → Basic information.',
  '更新设置': 'Update settings',
  '选择是否自动检查更新，以及使用的更新通道。':
    'Choose whether to check for updates automatically and which release channel to follow.',
  '自动检查已开启': 'Automatic checks on',
  '手动检查': 'Manual checks',
  '自动检查更新': 'Check for updates automatically',
  '只检查并提示新版本，不会自动安装。更新服务接入后生效。':
    'Only checks and notifies about new versions, never installs them. Takes effect once the update service is connected.',
  '更新通道': 'Release channel',
  '检查频率': 'Check frequency',
  '仅在开启自动检查时使用。': 'Only used when automatic checks are on.',
  '更新服务上线前，这两项可以留空。':
    'Before the update service ships, both fields may stay empty.',
  '已填写': 'Filled in',
  '服务器地址': 'Server address',
  '留空表示暂不使用更新服务。': 'Leave empty to skip the update service for now.',
  '端口': 'Port',
  '留空使用协议默认端口。': 'Leave empty to use the protocol default port.',
  '默认端口': 'Default port',
  '端口必须是 1–65535 之间的整数。': 'The port must be an integer between 1 and 65535.',
  '测试连接': 'Test connection',
  '更新服务暂未接入，连接测试会在接入后开放。':
    'The update service is not connected yet; the connection test will open once it is.',
  '更新摘要': 'Update summary',
  '自动检查': 'Automatic checks',
  '已开启': 'On',
  '已关闭': 'Off',
  '最近检查': 'Last check',
  '尚未接入更新服务': 'Update service not connected',
  '从未检查': 'Never checked',
  '更新服务接入前，检查更新只会提示服务尚未接入。':
    'Until the update service is connected, checking only reports that it is not available.',
  '更新不会动你的内容': 'Updates never touch your content',
  '更新只替换程序文件；文章、页面、媒体与数据库都在 data 目录里，升级前仍建议先备份。':
    'Updates only replace program files; posts, pages, media and the database live under data, so backing up first is still recommended.',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '更新设置已保存': 'Update settings saved',
  '更新服务端地址已记录；更新服务接入后生效。':
    'The update server address was recorded; it takes effect once the update service is connected.',
  '更新服务端留空，当前不会检查更新。':
    'The update server is empty, so updates are not checked right now.',
  '稳定版': 'Stable',
  '测试版': 'Beta',
  '每次启动': 'Every start',
  '每天': 'Daily',
  '每周': 'Weekly',
};

export default fragment;
