import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/SiteUpdate.tsx`、`lib/siteUpdate.ts` */
const fragment: Dictionary = {
  '站点更新': 'Site updates',
  '检查更新': 'Check for updates',
  '保存设置': 'Save settings',
  '查看当前版本与远端发布版本，决定手动还是自动检查更新。更新只替换程序文件，文章、页面、媒体与数据库都在 data 目录里。':
    'See the current version and the published one, then choose manual or automatic checks. An update only replaces program files; posts, pages, media and the database live under data.',
  '版本清单写在仓库里': 'The version manifest lives in the repository',
  '仓库里的 apps/web/public/version.json 记录四个核心字段：标题、说明、版本号与发布渠道（稳定版 / 测试版 / 本地构建）。检查更新时由服务端读取这份清单，和本机版本比较。':
    'The repository file apps/web/public/version.json holds four core fields: title, description, version and release channel (stable / beta / local build). When you check for updates the server reads that manifest and compares it with the local version.',
  '当前站点': 'Current site',
  '站点显示名称与当前运行的软件版本。': 'The site display name and the software version that is running.',
  '站点显示名称': 'Site display name',
  '未命名站点': 'Untitled site',
  '当前版本': 'Current version',
  '运行模式': 'Run mode',
  '演示模式': 'Demo mode',
  '正式站点': 'Live site',
  '站点显示名称可在「站点设置 → 基本信息」里修改。':
    'The site display name can be changed under Site settings → Basic information.',
  '更新设置': 'Update settings',
  '选择手动更新还是自动更新，以及跟随哪个发布通道。':
    'Choose manual or automatic updates and which release channel to follow.',
  '更新方式': 'Update mode',
  '检查频率': 'Check frequency',
  '自动更新时按这个频率在后台检查。': 'Automatic updates check in the background at this frequency.',
  '手动更新模式下只有点「检查更新」时才读取清单。':
    'In manual mode the manifest is read only when you press Check for updates.',
  '更新通道': 'Release channel',
  '稳定版通道忽略测试版；测试版通道同时接受两者。':
    'The stable channel ignores betas; the beta channel accepts both.',
  '自动更新只负责发现并提示新版本（{interval}检查一次），不会在你写作时刷新页面；真正把新版本装上仍需要你确认。':
    'Automatic updates only find and announce new versions (checked {interval}); the page never reloads while you are writing, and installing a new version still needs your confirmation.',
  '每次打开后台': 'each time the dashboard opens',
  '每隔一段时间': 'at the configured interval',
  '更新源': 'Update source',
  '服务端会去这个地址读取版本清单，再和本机版本比较。':
    'The server reads the version manifest from this address and compares it with the local version.',
  '标准地址，无需端口': 'Standard address, no port needed',
  '服务器地址': 'Server address',
  '自定义地址': 'Custom address',
  '这个地址不在预置列表里，按自定义地址使用。':
    'This address is not one of the presets, so it is used as a custom source.',
  '立即检查': 'Check now',
  '最近检查：{time}': 'Last checked: {time}',
  '还没有检查过。': 'Not checked yet.',
  '远端版本': 'Remote version',
  '发布说明': 'Release notes',
  '检查结果': 'Result',
  '检查方式': 'Checked by',
  '由本机服务端读取清单': 'The local server read the manifest',
  '服务端不可用，浏览器直接读取清单': 'The server was unavailable, so the browser read the manifest',
  '发现新版本 {version}，可按下面的「手动更新」切换。':
    'Version {version} is available; switch to it under Manual update below.',
  '本机版本比远端更新，可能是自己构建的版本。':
    'This build is newer than the published one; it may be a self-built package.',
  '远端是测试版，当前通道是稳定版，所以不提示更新。需要测试版请切换通道。':
    'The published build is a beta while the channel is stable, so it is not offered. Switch the channel to follow betas.',
  '手动更新': 'Manual update',
  '已经下载好新版本？把构建目录交给服务端，它会在不停进程的情况下换上去。':
    'Already downloaded a new version? Hand the build directory to the server and it swaps it in without stopping.',
  '不停机': 'No downtime',
  '新版本构建目录': 'New build directory',
  '填解压后 dist 目录的完整路径（里面要有 index.html 与 version.json）。只有运行站点的这台电脑可以操作。':
    'Enter the full path of the extracted dist directory (it must contain index.html and version.json). Only the computer running the site may do this.',
  '立即切换': 'Switch now',
  '新版本已经就位': 'The new version is in place',
  '已从 {previous} 切换到 {version}，服务端没有停止。':
    'Switched from {previous} to {version} without stopping the server.',
  '未知版本': 'unknown version',
  '其他设备会继续用旧页面，直到它们下一次加载。':
    'Other devices keep using the old pages until they reload.',
  '重新载入到新版本': 'Reload into the new version',
  '自动下载并安装新版本还没实现（服务端部分稍后补上）；现在这一栏就是完整的手动更新路径。':
    'Downloading and installing automatically is not implemented yet (the server half comes later); this section is the complete manual update path today.',
  '更新摘要': 'Update summary',
  '尚未检查': 'Not checked',
  '最近检查': 'Last check',
  '从未检查': 'Never checked',
  '版本清单的四个字段：标题、说明、版本号与发布渠道。':
    'The manifest has four fields: title, description, version and release channel.',
  '更新不会动你的内容': 'Updates never touch your content',
  '更新只替换程序文件；文章、页面、媒体与数据库都在 data 目录里，升级前仍建议先备份。':
    'Updates only replace program files; posts, pages, media and the database live under data, so backing up first is still recommended.',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '更新设置已保存': 'Update settings saved',
  '自动更新已开启，会按所选频率在后台检查；发现新版本只提示，不会打断编辑。':
    'Automatic updates are on and will check in the background at the chosen frequency; new versions are only announced, never forced.',
  '手动更新已开启：只有你点「检查更新」时才会读取版本清单。':
    'Manual updates are on: the version manifest is read only when you press Check for updates.',
  '发现新版本 {version}': 'Version {version} is available',
  '已是最新版本': 'Already up to date',
  '已是最新版本。': 'Already up to date.',
  '没有可用的新版本': 'No new version available',
  '更新检查失败': 'Update check failed',
  '请先填入新版本构建目录的完整路径。':
    'Enter the full path of the new build directory first.',
  '已切换到新版本 {version}': 'Switched to version {version}',
  '服务端没有停过；其他设备会继续用旧页面，直到它们下一次加载。':
    'The server never stopped; other devices keep the old pages until they reload.',
  '切换失败，请检查目录后重试。': 'Switching failed; check the directory and try again.',
  '切换失败': 'Switch failed',
  '现在先不切换': 'Not switching right now',
  '你正在输入内容，等手头这段写完再重新载入。':
    'You are typing; reload once you finish this part.',
  '重新载入失败': 'Reload failed',
  '新版本的资源没有取全，已保持当前页面。':
    'Not all new assets could be fetched, so the current page stays as it is.',
  '自动更新': 'Automatic update',
  '只有点「检查更新」时才读取清单，检查通过后再由你决定什么时候更新。':
    'The manifest is read only when you press Check for updates, and you decide when to apply it.',
  '后台按频率读取清单；发现新版本时只提示，不会打断正在编辑的内容。':
    'The manifest is read in the background at the configured frequency; a new version is only announced, never forced while you edit.',
  'GitHub 官方仓库': 'Official GitHub repository',
  '从 GitHub 读取版本清单，国内网络可能较慢。':
    'Reads the manifest from GitHub; this can be slow from some networks.',
  'jsDelivr 镜像': 'jsDelivr mirror',
  'GitHub 访问不稳时用这个镜像，内容与官方仓库一致。':
    'Use this mirror when GitHub is unreliable; the content matches the official repository.',
  '本站 version.json': 'This site’s version.json',
  '直接读本站自己的清单，适合自建构建与离线检查。':
    'Reads this site’s own manifest; handy for self-built packages and offline checks.',
  '稳定版': 'Stable',
  '测试版': 'Beta',
  '本地版本': 'Local build',
  '每次启动': 'Every start',
  '每天': 'Daily',
  '每周': 'Weekly',
};

export default fragment;
