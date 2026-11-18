import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/ThemeBuilder.tsx` */
const fragment: Dictionary = {
  页面编排: 'Page layout',
  自定义主题: 'Custom theme',
  已开启不同设备分割: 'Device-specific layouts on',
  '桌面 / 平板 / 手机现在各有一份独立编排，切换设备再编辑。':
    'Desktop, tablet and mobile each have their own arrangement now; switch devices to edit each one.',
  已关闭不同设备分割: 'Device-specific layouts off',
  '三台设备重新共用同一份编排（保留桌面版）。':
    'All three devices share one arrangement again (the desktop version is kept).',
  首页已恢复默认编排: 'Home page restored to the default arrangement',
  页面编排已恢复默认: 'Page layout restored to defaults',
  '仍可以按 Ctrl/Cmd + Z 撤销。': 'You can still undo it with Ctrl/Cmd + Z.',
  '文章页附加区块已清空；文章正文与评论区不受影响。':
    'The extra blocks on article pages are cleared; article bodies and comments are unaffected.',
  '已按原模板重建组件；页面正文、标题和路径没有改变。':
    'Blocks were rebuilt from the original template; the page body, title and path are unchanged.',
  '组件已清空，页面正文仍会显示。':
    'The blocks are cleared; the page body will still be shown.',
  首页: 'Home',
  文章页: 'Article page',
  '页面：{title}': 'Page: {title}',
  站点管理员: 'Site admin',
  返回后台: 'Back to dashboard',
  编辑页面: 'Edit page',
  撤销: 'Undo',
  重做: 'Redo',
  恢复默认: 'Restore defaults',
  收起面板: 'Hide panels',
  展开面板: 'Show panels',
  '两边的面板会浮在预览上；收起后就是访客看到的整幅页面':
    'The side panels float above the preview; hiding them shows the full page exactly as visitors see it',
  主题设置: 'Theme settings',
  组件与结构: 'Blocks and structure',
  组件: 'Blocks',
  区块属性: 'Block properties',
  逻辑链: 'Logic chain',
  属性: 'Properties',
  无代码逻辑链: 'No-code logic chain',
  '当…发生时，满足条件，就执行动作。逻辑保存在安装配置里，前台由 LogicRuntime 执行。':
    'When… happens and the conditions match, the action runs. Logic is stored in the site configuration; LogicRuntime executes it on the front end.',
  '恢复首页的默认编排？': 'Restore the default home layout?',
  '清空文章页附加区块？': 'Clear the extra article page blocks?',
  '恢复「{name}」的默认编排？': 'Restore the default layout for “{name}”?',
  '恢复「页面」的默认编排？': 'Restore the default layout of this page?',
  '首页会回到当前布局变体的默认组件；仍可以撤销。':
    'The home page returns to the default blocks of the current layout variant; you can still undo.',
  '只会清空文章页正文之后附加的区块；文章正文、评论区与 SEO 不受影响。':
    'Only the blocks added after the article body are cleared; article bodies, comments and SEO are unaffected.',
  '会按原模板重建组件。页面正文、标题、路径与发布状态都不会改变。':
    'Blocks are rebuilt from the original template. The page body, title, path and publish status stay the same.',
  '这个页面没有模板，恢复后会清空组件；正文仍会显示。':
    'This page has no template, so restoring clears the blocks; the body will still be shown.',
  '只重置编排，不动内容': 'Only the layout is reset; the content is kept',
  '文章、页面正文、评论、账户与媒体都不会被删除。恢复后可以按 Ctrl/Cmd + Z 撤销。':
    'Articles, page bodies, comments, accounts and media are never deleted. You can undo the restore with Ctrl/Cmd + Z.',
  // ---- 保存护栏（规格 §4.5 体积预算） ----
  '这份编排有 {count} 个区块，超过上限 {limit} 个。请先删掉一些再保存。':
    'This layout has {count} blocks, over the limit of {limit}. Delete some before saving.',
  // ---- 预览只停留在正在编排的页面（见 components/PreviewBridge.tsx） ----
  预览里不能跳转到其他页面: 'The preview cannot navigate to other pages',
  '想编辑别的页面，请用顶部「编辑页面」切换；想查看真实前台，点「新窗口」。':
    'To edit another page, switch it in “Edit page” at the top; to browse the real site, open it with “New window”.',
  // ---- 版面迁移的一次性说明（规格 §5.1） ----
  版面已自动升级: 'Your layout was upgraded automatically',
  知道了: 'Got it',
};

export default fragment;
