import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Settings.tsx` */
const fragment: Dictionary = {
  '站点设置': 'Site settings',
  '站点名称不能为空。': 'The site name cannot be empty.',
  '后台入口地址必须是以 / 开头且不含空格的路径。':
    'The admin path must start with / and contain no spaces.',
  '账户角色同步失败': 'Could not sync account roles',
  '请在「用户管理」里手动调整。': 'Adjust the roles manually in Users.',
  '站点形态已切换': 'Site type switched',
  '站点设置已保存': 'Site settings saved',
  '个人博客模式已生效：注册入口关闭，所有账户都能登录后台。':
    'Personal blog mode is on: sign-up is closed, and every account can sign in to the dashboard.',
  '社区站点模式已生效：注册重新开放，权限组按角色生效。':
    'Community site mode is on: sign-up is open again, and groups apply by role.',
  '保存失败。': 'Save failed.',
  '左侧切换基本信息、访问与域名、SEO 与性能优化；登录方式与日志有独立入口。':
    'Use the left column to switch between basic info, access and domains, and SEO and performance; sign-in methods and logs have their own pages.',
  '站点语言': 'Site language',
  '切换后前台、后台与全部提示文案立即改用该语言；已发布的内容不会被翻译。':
    'The site, the dashboard, and every message switch to that language right away; published content is not translated.',
  '简体中文界面。': 'Simplified Chinese interface.',
  '站点语言是站点级设置：所有访客看到的语言一致，并随站点设计同步到服务器。切换会立即生效，不需要点保存。':
    'Site language is a site-wide setting: every visitor sees the same language, and it syncs to the server along with the site design. Changes take effect immediately, so no save is needed.',
  '基本信息': 'Basic info',
  '显示在首页、页脚与分享卡片里。': 'Shown on the home page, in the footer, and in share cards.',
  '站点名称': 'Site name',
  '访问域名': 'Domain',
  '留空时生产环境只允许公网 IP 直接访问。SSL 证书与别名域名在「访问与域名」里配置。':
    'When empty, production only allows direct access by public IP. SSL certificates and alias domains are configured in Access & Domains.',
  '站点简介': 'Site description',
  '当前后端未返回简介；不修改时不会覆盖服务端已有的值。':
    'This backend does not return a description; if you do not change it, the existing server value is kept.',
  '显示在首页与页脚。首页大标题在「外观 → 首页首屏」修改。':
    'Shown on the home page and in the footer. Edit the home page headline in Appearance → Hero.',
  '站点图标': 'Site icon',
  '浏览器标签页与收藏夹图标（favicon），填 http(s) 或站内绝对路径，建议 32×32 / 64×64。留空使用内置图标。':
    'Browser tab and bookmark icon (favicon). Use an http(s) URL or an absolute path on this site; 32×32 / 64×64 is recommended. Leave empty to use the built-in icon.',
  '站点图标预览': 'Site icon preview',
  '后台入口地址': 'Admin path',
  '自定义后台登录入口路径，例如 /manage。保存后下次从该地址进入后台。':
    'Customize the dashboard sign-in path, for example /manage. After saving, open the dashboard from that address.',
  '在页脚展示中国内地备案信息': 'Show mainland China filing info in the footer',
  '面向中国大陆用户时开启；海外站点可以保持关闭，页脚会隐藏 ICP 备案号与公安网备。':
    'Turn this on for audiences in mainland China; sites elsewhere can leave it off and the footer will hide the ICP and public security filing numbers.',
  'ICP 备案号': 'ICP filing number',
  '显示在页脚并链接到工信部备案系统。': 'Shown in the footer, linked to the MIIT filing system.',
  '例如：京 ICP 备 00000000 号': 'e.g. ICP filing No. 00000000',
  '公安网备号': 'Public security filing number',
  '显示在页脚并链接到全国互联网安全管理服务平台。':
    'Shown in the footer, linked to the national internet security management platform.',
  '例如：京公网安备 11010502030123 号': 'e.g. Public security filing No. 11010502030123',
  '公安网备图标': 'Public security filing icon',
  '填写图标 URL；留空使用内置盾牌图标。':
    'Provide an icon URL; leave it empty to use the built-in shield icon.',
  '站点路径（slug）': 'Site path (slug)',
  '创建站点时生成，不能在此修改。': 'Generated when the site was created; it cannot be changed here.',
  '站点形态': 'Site type',
  '决定访客能否创建账户，以及前台是否显示注册与登录入口。':
    'Decides whether visitors can create accounts and whether the site shows sign-up and sign-in entry points.',
  '关闭自助注册。站长可以创建账户，所有账户都能登录后台并拥有最高权限。':
    'Self sign-up is off. The site admin can create accounts, and every account can sign in to the dashboard with full permissions.',
  '访客可以自助注册，登录后评论、收藏与投稿；权限按权限组划分。':
    'Visitors can sign up, then comment, bookmark, and submit posts; permissions are split by group.',
  '个人博客：注册关闭，账户由站长创建': 'Personal blog: sign-up closed, accounts created by the site admin',
  '保存后前台不再显示注册入口，注册页关闭；已有账户、文章与评论全部保留，可以继续登录。':
    'After saving, the site stops showing a sign-up entry point and the sign-up page closes; existing accounts, articles, and comments are all kept, and everyone can still sign in.',
  '个人博客下所有账户都能进入后台并拥有最高权限，可以在「用户管理」里创建账户。':
    'On a personal blog every account can open the dashboard with full permissions; create accounts in Users.',
  '连接真实后端时，要彻底关闭注册还需要在网关或服务端禁止':
    'With a real backend, fully closing sign-up also means blocking',
  '。': '.',
  '社区站点：自助注册与用户组': 'Community site: self sign-up and groups',
  '访客可以自助注册成为成员；成员、审核员、管理员与最高管理员的能力可以在「用户组」里逐项调整。':
    'Visitors can sign up as members; the abilities of members, reviewers, admins, and platform admins can be tuned item by item in Groups.',
  '从个人博客切回社区站点时，之前创建的账户会恢复各自用户组，文章与评论不受影响。':
    'When you switch from a personal blog back to a community site, existing accounts get their own groups back; articles and comments are unaffected.',
  '访客模式': 'Visitor mode',
  '决定匿名访客能否读取已发布内容。': 'Decides whether anonymous visitors can read published content.',
  '未登录访客可以读已发布内容，匿名请求按站点解析。':
    'Signed-out visitors can read published content; anonymous requests resolve to the site.',
  '所有内容都要求登录；匿名请求返回 401。': 'All content requires signing in; anonymous requests return 401.',
  '发布模式': 'Publish mode',
  '决定成员发布时是否需要审核。': 'Decides whether member submissions need review.',
  '成员可以从草稿直接发布，不再进入审核队列。':
    'Members can publish straight from a draft without joining the review queue.',
  '所有成员（包括编辑）的稿件都需要另一位编辑审核。':
    'Every member’s draft, editors included, needs review by another editor.',
  '普通成员需要审核；编辑与管理员可以直接发布。':
    'Regular members need review; editors and admins can publish directly.',
  '固定的阅读与发布规则': 'Fixed reading and publishing rules',
  '个人博客固定为公开阅读与直接发布：没有其他成员，也没有需要审核的稿件。':
    'A personal blog is fixed to public reading and direct publishing: there are no other members and no drafts waiting for review.',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '演示数据': 'Demo data',
  '清空浏览器里的示例文章、评论、成员与上传记录，并重新载入安装流程。':
    'Clear the sample articles, comments, members, and uploads stored in this browser, then reload the setup flow.',
  '重置演示数据': 'Reset demo data',
  '切换到个人博客？': 'Switch to a personal blog?',
  '切换到社区站点？': 'Switch to a community site?',
  '注册入口会关闭，所有账户获得后台最高权限。':
    'Sign-up will close, and every account gets full dashboard permissions.',
  '注册入口重新开放，权限组按角色生效。': 'Sign-up will reopen, and groups apply by role.',
  '确认切换': 'Switch site type',
  '数据不会丢失': 'No data will be lost',
  '账户、文章、评论、媒体与页面全部保留。切换只改变注册入口、登录策略与权限模型，':
    'Accounts, articles, comments, media, and pages are all kept. The switch only changes the sign-up entry point, the sign-in policy, and the permission model,',
  '不会删除或重建任何数据。': 'and nothing is deleted or rebuilt.',
  '已有账户': 'Existing accounts',
  '全部保留，并且都能登录后台；在个人博客下统一按最高管理员处理。':
    'All kept, and all can sign in to the dashboard; on a personal blog they are all treated as full admins.',
  '角色记录': 'Role records',
  '原角色原样保存，切回社区站点后自动恢复。':
    'Previous roles are stored as they were and restored automatically when you switch back to a community site.',
  '阅读与发布': 'Reading and publishing',
  '固定为公开阅读与直接发布，避免出现无人可审的稿件。':
    'Fixed to public reading and direct publishing so no draft is left without a reviewer.',
  '全部保留，并按各自角色回到成员、审核员、管理员或最高管理员组。':
    'All kept, and each returns to the member, reviewer, admin, or platform admin group by role.',
  '注册': 'Sign-up',
  '前台重新显示注册入口；新账户默认是普通成员。':
    'The site shows the sign-up entry point again; new accounts are regular members by default.',
  '权限组': 'Groups',
  '可以在「权限组」里逐项调整五组能力。':
    'You can tune the abilities of the five groups item by item in Groups.',
  '重置演示数据？': 'Reset demo data?',
  '所有本地文章、评论、成员、通知与上传记录都会被清空。':
    'All local articles, comments, members, notifications, and upload records will be erased.',
  '清空并重新开始': 'Erase and start over',
  '这个操作不可撤销': 'This cannot be undone',
  '演示数据只存在这台电脑的浏览器里。重置前请确认没有需要保留的草稿。':
    'Demo data lives only in this browser on this computer. Before resetting, make sure no draft needs to be kept.',
};

export default fragment;
