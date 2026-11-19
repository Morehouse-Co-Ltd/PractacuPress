import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/Setup.tsx` */
const fragment: Dictionary = {
  '安装引导': 'Setup wizard',
  '安装完成': 'Setup complete',
  '安装进度': 'Setup progress',
  '安装语言 / Setup language': 'Setup language',
  '欢迎': 'Welcome',
  '运行方式': 'Runtime',
  '数据库': 'Database',
  '管理员': 'Administrator',
  '默认站点': 'Default site',
  '登录方式': 'Sign-in methods',
  '检查与完成': 'Checks and finish',
  '从这里开始': 'Start here',
  '连接后端或演示': 'Connect a backend or use demo',
  '第一个账户': 'First account',
  '名称、域名与规则': 'Name, domain, and rules',
  '邮箱、手机、OAuth': 'Email, phone, OAuth',
  '迁移、健康检查': 'Migrations, health checks',
  '服务就绪': 'Service ready',
  '数据存储': 'Data storage',
  '内置安全检查': 'Built-in security checks',
  '站点可访问': 'Site reachable',
  'OpenAPI 文档': 'OpenAPI docs',
  '等待检查': 'Waiting for check',
  '同源': 'same origin',
  '已找到 API（{base}），但依赖未就绪（readyz {ready}）。请先执行迁移与 seed。':
    'Found the API ({base}), but its dependencies are not ready (readyz {ready}). Run migrations and seed first.',
  '没有发现可用的后端。已尝试：{bases}。': 'No usable backend found. Tried: {bases}.',
  '没有发现可用的后端': 'No usable backend found',
  '该账户不是站点管理员，无法完成站点配置。请使用安装时创建的管理员账户，或让平台管理员提升权限。':
    'This account is not a site administrator, so site setup cannot be completed. Use the administrator account created during setup, or ask a platform administrator for the permission.',
  '该账户不是站点管理员，无法完成站点配置。':
    'This account is not a site administrator, so site setup cannot be completed.',
  '该邮箱已经注册。请改用「使用已有管理员账户登录」。':
    'This email is already registered. Use “Sign in with an existing administrator account” instead.',
  '没有可用的登录会话，请返回上一步重新登录。':
    'No active sign-in session. Go back one step and sign in again.',
  '请填写数据库主机。': 'Enter the database host.',
  '请填写数据库名称。': 'Enter the database name.',
  '请填写数据库用户。': 'Enter the database user.',
  '请填写管理员邮箱。': 'Enter the administrator email.',
  '请填写密码。': 'Enter the password.',
  '请填写有效的邮箱地址。': 'Enter a valid email address.',
  '请填写显示名称。': 'Enter a display name.',
  '显示名称不能超过 120 个字符。': 'The display name cannot exceed 120 characters.',
  '密码至少 12 位。': 'The password must be at least 12 characters.',
  '密码不能超过 128 位。': 'The password cannot be longer than 128 characters.',
  '两次输入的密码不一致。': 'The two passwords do not match.',
  '站点名称不能为空。': 'The site name cannot be empty.',
  '站点名称不能超过 160 个字符。': 'The site name cannot exceed 160 characters.',
  '请填写访问域名。': 'Enter a domain.',
  '站点简介不能超过 2000 个字符。': 'The site description cannot exceed 2000 characters.',
  '请补齐{providers}的必填项，或者先关闭该方式。':
    'Complete the required fields for {providers}, or turn that method off for now.',
  '本地演示环境': 'Local demo environment',
  '不需要后端服务，数据写入浏览器 localStorage。':
    'No backend needed; data is written to browser localStorage.',
  '浏览器禁用了 localStorage。': 'The browser has disabled localStorage.',
  '演示数据可以持久化到本机。': 'Demo data can persist on this machine.',
  '无法持久化，刷新后会丢失。': 'Cannot persist; data is lost on refresh.',
  '演示模式不调用 内置安全清洗；真实发布与上传需要它可用。':
    'Demo mode does not call the built-in security checks; live publishing and uploads need it.',
  '演示站点将在此浏览器内立即生效。': 'The demo site takes effect in this browser immediately.',
  '接口契约版本 0.1.0（演示模式不提供在线文档）。':
    'Contract version 0.1.0 (demo mode offers no online docs).',
  '无法连接': 'Cannot connect',
  '数据库与迁移': 'Database and migrations',
  '就绪检查覆盖数据库连接；迁移由安装脚本执行。':
    'The readiness check covers the database connection; migrations run from the install script.',
  '依赖未就绪，请先执行迁移。': 'Dependencies are not ready; run migrations first.',
  '没有独立的健康端点；发布与上传会 fail-closed，安全检查不可用时返回 503。':
    'There is no standalone health endpoint; publishing and uploads fail closed and return 503 when the security check is unavailable.',
  '站点为「登录后浏览」，匿名请求被正确拒绝（401）。':
    'The site is members-only; anonymous requests are correctly rejected (401).',
  '返回的不是 JSON，可能被前端或反向代理的 fallback 接管。':
    'The response was not JSON; a front-end or reverse-proxy fallback may have taken over.',
  '匿名读取返回 200。': 'Anonymous reads return 200.',
  '返回 {status}。': 'Returned {status}.',
  '请求失败。': 'Request failed.',
  '未取到 openapi.json。': 'openapi.json could not be fetched.',
  '{url} 可读取。': '{url} is readable.',
  '尚未完成管理员登录。': 'Administrator sign-in is not complete.',
  '{name} 已经准备好了': '{name} is ready',
  '演示数据已写入此浏览器。你可以随时在「站点设置」里重新运行安装引导或重置数据。':
    'Demo data is now in this browser. You can rerun setup or reset the data from Site settings at any time.',
  '管理员账户与站点规则已写入服务端。下面的地址可以用来访问站点和接口文档。':
    'The administrator account and site rules are stored on the server. The addresses below open the site and the API docs.',
  '个人博客不开放注册，访客无需账户即可阅读全部已发布内容。':
    'A personal blog does not open registration; visitors can read everything published without an account.',
  '站点前台': 'Site front end',
  '管理后台': 'Admin',
  'API 根路径': 'API base path',
  '演示模式 · 无远程 API': 'Demo mode · no remote API',
  '契约 0.1.0 · 演示模式': 'Contract 0.1.0 · demo mode',
  '站点形态': 'Site type',
  '仅站长可登录': 'Owner sign-in only',
  '开放注册': 'Registration open',
  '站点规则': 'Site rules',
  '邮箱密码': 'Email and password',
  '访问端口': 'Access port',
  '默认': 'Default',
  '（可在站点设置修改）': ' (changeable in Site settings)',
  '进入管理后台': 'Open the dashboard',
  '查看站点': 'View site',
  '先给这间编辑部': 'First, give this newsroom',
  '盖一座房子。': 'build a house.',
  '接下来六步会创建第一个管理员、一个默认站点和它的发布规则。所有选项之后都能在管理后台修改。':
    'The next six steps create the first administrator, a default site, and its publishing rules. Everything can be changed later in the dashboard.',
  '一个平台管理员账户，以及一条可解释的角色边界。':
    'One platform administrator account, with a role boundary you can explain.',
  '一个默认站点：名称、域名、站点形态（个人博客或社区）与发布规则。':
    'A default site: name, domain, site type (personal blog or community), and publishing rules.',
  '一次健康检查，确认数据库、站点与契约文档都可达。':
    'One health check that confirms the database, the site, and the contract docs are reachable.',
  '角色': 'Roles',
  '4 级': '4 levels',
  '阶段': 'Phases',
  '6 步': '6 steps',
  '契约': 'Contract',
  '先选一套大主题：配色、排版和单栏 / 卡片 / 双栏版式会一起切换。 之后可在「主题设置」里微调、导入或删除自定义主题。':
    'Pick a theme first: colours, typography, and the single-column / cards / two-column layout switch together. You can fine-tune, import, or delete custom themes in Theme settings later.',
  '双栏': 'Two-column',
  '单栏': 'Single column',
  '当前：{theme}· {mode}。页面编排与主题微调在后台「主题设置」里。':
    'Current: {theme}· {mode}. Page composition and theme tweaks live in Theme settings in the dashboard.',
  '自定义': 'Custom',
  '深色': 'Dark',
  '浅色': 'Light',
  '第': 'Step',
  '步 ·': '·',
  '第 {step} 步，共 {total} 步': 'Step {step} of {total}',
  '第 {step} 步，共 {total} 步 · 数据库由后端配置':
    'Step {step} of {total} · database configured by the backend',
  '由后端配置 · 已跳过': 'Configured by the backend · skipped',
  '引导只写入必要的站点配置。Client Secret、短信密钥与数据库连接留在服务端，不会进入浏览器。':
    'Setup only writes the site configuration it needs. Client secrets, SMS keys, and database connections stay on the server and never enter the browser.',
  '服务端的站点已经不在了': 'The site on the server is gone',
  '这台机器的 data 目录被删除或重建过，浏览器里记着的安装配置已经对不上， 所以重新打开了安装引导。已有的内容需要从备份的 data 目录恢复。':
    'The data directory on this machine was deleted or rebuilt, so the saved install config in this browser no longer matches and the setup wizard reopened. Existing content has to be restored from a backed-up data directory.',
  '先决定这间房子接在哪里。': 'First decide where this house connects.',
  '连接真实后端时，所有写入都会经过 Go API 与 内置安全清洗；演示模式不需要启动任何服务，数据只保存在此浏览器。':
    'With a live backend every write goes through the Go API and the built-in security checks; demo mode needs no services and keeps data in this browser only.',
  '演示数据（本地）': 'Demo data (local)',
  '无需后端。内置一组文章、成员、评论与通知，适合先看完整界面和审核流程。':
    'No backend needed. Ships with articles, members, comments, and notifications to explore the full interface and review flow.',
  '推荐 · 立即可用': 'Recommended · ready now',
  '真实环境': 'Live environment',
  '程序已经在本机跑起 Go API 与 SQLite，直接连接同源接口，不需要填写地址。':
    'The local app runs the Go API and SQLite on this machine; it connects to the same-origin API, so no address is needed.',
  '自动连接同源接口或本机 8080 的 Go API，不需要填写地址。':
    'Connects automatically to the same-origin API or the Go API on local 8080; no address is needed.',
  '本机 API 已就绪 · 零配置': 'Local API ready · zero config',
  '零配置 · 自动检测': 'Zero config · auto-detect',
  '正在自动寻找后端…': 'Looking for a backend automatically…',
  '已连接到后端': 'Connected to the backend',
  '等待自动连接': 'Waiting to connect',
  '依次尝试同源接口与本机 127.0.0.1:8080，不需要填写地址。':
    'Tries the same-origin API and 127.0.0.1:8080 in turn; no address is needed.',
  '连接失败。': 'Connection failed.',
  '选中真实环境后会自动连接，不需要手动检测。':
    'Choosing the live environment connects automatically; no manual check is needed.',
  '重新检测': 'Check again',
  '更换地址': 'Change address',
  '连接': 'Connect',
  '本机 API 没有通过就绪检查': 'The local API did not pass the readiness check',
  '程序已经把 API 拉起来了，但接口还没准备好。程序窗口里有退出原因，完整日志在':
    'The app started the API, but the endpoints are not ready yet. The window shows why it exited; the full log is in',
  '。': '.',
  '这个程序没有运行本机 API': 'The local app is not running an API',
  '程序尝试启动本机 API 失败了，原因如下：':
    'The local app failed to start the API. The reason is below:',
  '程序以静态方式运行，没有找到 PractacuPress.exe，所以同源与 8080 都没有后端。':
    'The app is running statically and could not find PractacuPress.exe, so neither the same origin nor 8080 has a backend.',
  '请使用完整的 Windows 压缩包重新解压（里面应同时有':
    'Unzip the complete Windows archive again (it should contain both',
  '与': 'and',
  '），或按下面的命令手动启动 Go API。': '), or start the Go API manually with the commands below.',
  '不用填地址，但后端需要先启动': 'No address needed, but start the backend first',
  '前端会自动尝试同源与': 'The front end automatically tries the same origin and',
  '。在仓库根目录启动 Go API 后点「重试」即可；如果只是想先看界面，可以直接切到演示数据。 后端已启动仍失败时，多半是跨域限制：开发时用':
    '. Start the Go API from the repository root and click Retry; if you only want to look at the interface, switch to demo data. If it still fails with the backend running, it is usually CORS: in development use',
  '（': '(',
  '会代理到 8080），生产用同域反向代理。':
    'proxies to 8080), and use a same-domain reverse proxy in production.',
  '先以演示数据继续': 'Continue with demo data first',
  '重试连接': 'Retry connection',
  '收起手动设置': 'Hide manual settings',
  '手动指定地址': 'Set the address manually',
  'API 地址': 'API address',
  '只有后端不在同源、也不在本机 8080 时才需要填写。':
    'Only needed when the backend is neither same-origin nor on local 8080.',
  '使用这个地址': 'Use this address',
  '跨域部署需要在服务端设置': 'Cross-origin deployments need',
  '并允许凭据； 推荐把前端与 API 放在同一域名下由反向代理转发。':
    'and allow credentials; putting the front end and the API on one domain behind a reverse proxy is recommended.',
  '演示模式写入哪里？': 'Where does demo mode write?',
  '站点、文章、评论与上传的图片都保存在':
    'The site, articles, comments, and uploaded images are all stored in',
  '。清除浏览器数据会一并清空； 可在「站点设置 → 重新运行安装引导」里重置。':
    '. Clearing browser data clears it too; reset it from Site settings → Run setup again.',
  '选一个装得下稿子的柜子。': 'Pick a cabinet big enough for the manuscripts.',
  '后端支持 SQLite、MySQL 与 PostgreSQL。浏览器不能修改服务端进程的环境变量，这里选择的方案会生成一份可直接粘贴的配置片段。':
    'The backend supports SQLite, MySQL, and PostgreSQL. A browser cannot change the server process environment, so your choice here produces a config snippet you can paste as is.',
  '单机、演示与小规模部署的默认选择。无需额外进程，备份就是一个文件。':
    'The default for single-machine, demo, and small deployments. No extra process; a backup is one file.',
  '默认 · Windows 本地安装': 'Default · local Windows install',
  '已有 MySQL 基础设施的团队。需要提供连接串与账号权限。':
    'For teams that already run MySQL. Needs a connection string and account permissions.',
  'SaaS 多站点生产的推荐选择。事务与并发场景更稳。':
    'Recommended for multi-site SaaS in production. Transactions and concurrency are steadier.',
  '推荐 · 生产': 'Recommended · production',
  '主机': 'Host',
  '端口': 'Port',
  '数据库名': 'Database name',
  '用户名': 'Username',
  '密码': 'Password',
  '查看密码': 'Show password',
  '隐藏密码': 'Hide password',
  '只用于生成本地配置片段，不会发送到任何地方。':
    'Only used to build the local config snippet; it is never sent anywhere.',
  '字符集 / 时区': 'Charset / time zone',
  '服务端配置片段': 'Server config snippet',
  '复制 .env': 'Copy .env',
  '把这两行写入服务端的': 'Add these two lines to the server',
  '或环境变量，然后执行': 'or environment variables, then run',
  '演示模式不会真正连接数据库。': 'Demo mode never connects to a real database.',
  '第一个账户，拥有全部权限。': 'The first account, with every permission.',
  '平台管理员可以管理站点、成员、全局安全策略与审计。至少保留一个可用的平台管理员账户。':
    'A platform administrator manages sites, members, global security policy, and the audit log. Keep at least one working platform administrator account.',
  '已登录为 {name}（{role}）。可以继续下一步。': 'Signed in as {name} ({role}). You can continue.',
  '管理员邮箱': 'Administrator email',
  '登录并继续': 'Sign in and continue',
  '返回创建新账户': 'Back to creating a new account',
  '显示名称': 'Display name',
  '会出现在文章署名和成员列表里。': 'Shown in article bylines and the member list.',
  '例如：林知远': 'e.g. Lin Zhiyuan',
  '邮箱': 'Email',
  '登录凭据，也用于身份绑定。': 'Sign-in credential, also used for identity linking.',
  '12–128 位，至少两类字符且不能是常见弱口令。建议使用长口令。': '12–128 characters with at least two character classes; common passwords are refused. A long passphrase is recommended.',
  '确认密码': 'Confirm password',
  '演示模式：账户只保存在此浏览器，密码不会上传。':
    'Demo mode: the account is kept in this browser only; the password is never uploaded.',
  '创建后会立即建立会话，并写入 Refresh Cookie。':
    'A session is created right away and a refresh cookie is set.',
  '已有管理员账户？': 'Already have an administrator account?',
  '记录管理员账户': 'Record the administrator account',
  '创建管理员并继续': 'Create administrator and continue',
  '权限在服务端强制校验': 'Permissions are enforced on the server',
  '角色一旦建立，所有查询与写入都会检查站点、身份、资源所有权和角色。前端隐藏按钮只改善体验，不构成安全边界。':
    'Once roles exist, every read and write checks the site, identity, resource ownership, and role. Hiding buttons in the front end only improves the experience; it is not a security boundary.',
  '给站点起一个名字，然后开门。': 'Name the site, then open the door.',
  '单站点模式下，访客不会看到「租户」或「站点选择」；这里创建的就是他们唯一会看到的网站。':
    'In single-site mode visitors never see “tenant” or “site selection”; this is the only site they will see.',
  '站点名称': 'Site name',
  '访问域名（选填）': 'Domain (optional)',
  '访问域名': 'Domain',
  '留空即可：单站点安装会自动匹配所有本机地址。填写自定义域名需要先完成域名验证，当前版本请留空。':
    'Leave it empty: a single-site install automatically matches any local address. A custom domain needs domain verification first, so leave it empty in this version.',
  '公开访问时按域名解析站点，例如 press.example.com。':
    'For public access the site is resolved by domain, for example press.example.com.',
  '留空 = 自动': 'Empty = automatic',
  '站点简介': 'Site description',
  '出现在首页与页脚。留空也可以。': 'Appears on the home page and in the footer. It can be left empty.',
  '站点路径（slug）': 'Site path (slug)',
  '由安装时创建，创建后不可在此修改。': 'Created during setup; it cannot be changed here.',
  '只有站长一个账户。访客可以直接阅读，注册与登录入口关闭。':
    'One account only, the owner. Visitors read directly; sign-up and sign-in are closed.',
  '访客可以自助注册，登录后评论、收藏与投稿。':
    'Visitors can sign up themselves, then comment, bookmark, and submit once signed in.',
  '个人博客固定为公开阅读、直接发布：唯一作者无法审核自己的稿件，所以没有审核队列。':
    'A personal blog is always public and publishes directly: a single author cannot review their own drafts, so there is no review queue.',
  '访客模式': 'Visitor mode',
  '未登录访客可以读已发布内容；草稿与审核队列仍然不可见。':
    'Signed-out visitors can read published content; drafts and the review queue stay hidden.',
  '所有内容都要求登录。匿名请求会收到 401。':
    'All content requires sign-in. Anonymous requests get a 401.',
  '发布模式': 'Publish mode',
  '成员可以直接发布，适合彼此信任的小团队。':
    'Members publish directly; suits small teams that trust each other.',
  '成员提交后进入待审核，由编辑或管理员发布。':
    'Member submissions go to review and are published by an editor or administrator.',
  '普通成员需要审核；编辑与管理员可直接发布。':
    'Regular members need review; editors and administrators publish directly.',
  '公开阅读 · 无需账户': 'Public reading · no account needed',
  '账户': 'Account',
  '仅站长可登录 · 注册关闭': 'Owner sign-in only · sign-up closed',
  '发布': 'Publish',
  '直接发布 · 无审核队列': 'Direct publishing · no review queue',
  '个人博客只保留一个账户': 'A personal blog keeps a single account',
  '安装时创建的管理员就是站长。前台不再显示注册与登录按钮，注册页会直接关闭，登录页只接受站长邮箱。 连接真实后端时，注册端点由服务端控制；要彻底关闭，需要在网关或服务端禁止':
    'The administrator created during setup is the site owner. The public site hides sign-up and sign-in buttons, the sign-up page closes, and the sign-in page only accepts the owner email. With a live backend the registration endpoint is controlled by the server; to close it completely, block',
  '这些规则保存后会立即生效。之后可以在「站点设置」里修改，所有变更都会写入审计记录。':
    'These rules take effect as soon as they are saved. You can change them later in Site settings; every change is written to the audit log.',
  '开门的方式，由你决定。': 'You decide how the door opens.',
  '个人博客只保留一个账户：注册关闭，邮箱与密码用于站长登录后台。手机验证码与第三方登录可以在这里打开，但登录页仍只接受站长账户。':
    'A personal blog keeps a single account: sign-up is closed, and the owner signs in to the dashboard with email and password. Phone codes and third-party sign-in can be enabled here, but the sign-in page still accepts only the owner account.',
  '邮箱与密码始终可用。手机验证码与第三方登录可以在这里直接选择并填写参数；密钥只写进服务端环境变量，不会保存在浏览器。':
    'Email and password are always available. Phone codes and third-party sign-in can be chosen and configured right here; the keys are written only to server environment variables and never stored in the browser.',
  '邮箱与密码': 'Email and password',
  '已启用': 'Enabled',
  '配置完成后会出现在登录页': 'Configured methods appear on the sign-in page',
  '填写完整的方式会显示在': 'Fully configured methods appear on',
  '的邮箱表单下方。演示模式可以模拟这些入口； 连接真实后端时，需要服务端实现对应的短信或 OAuth 端点——契约 v0.1.0 尚未包含它们。':
    'below the email form. Demo mode can simulate these entries; with a live backend the server must implement the matching SMS or OAuth endpoints — contract v0.1.0 does not include them yet.',
  '在开门之前，先绕房子走一圈。': 'Before opening the door, walk around the house.',
  '安全检查已编译进 API 进程；发布与上传失败时按设计 fail-closed。':
    'Security checks are compiled into the API process; publishing and uploads fail closed by design when a check fails.',
  '检查只读取健康端点与公开接口，不会修改数据。安全检查已编译进 API 进程，发布与上传流程会验证它。':
    'The checks only read health endpoints and public APIs and change no data. Security checks run inside the API process and are exercised by publishing and uploads.',
  '重新检查': 'Re-run checks',
  '演示模式': 'Demo mode',
  'http 访问要显式设置 PUBLIC_BASE_URL': 'An http site must set PUBLIC_BASE_URL explicitly',
  '未设置时服务端会按 https 推导第三方登录回调等绝对链接；通知邮件里的站内地址也依赖它。当前站点通过 http 访问，请把这一行加进 API 的环境变量后重启：':
    'When it is unset the server assumes https for absolute links such as third-party sign-in callbacks, and notification mail relies on it for its in-site link. This site is reached over http; add the line below to the API environment variables and restart:',
  '还有会阻塞安装的检查': 'Some checks still block setup',
  '服务就绪或数据存储未通过。请先启动后端、执行迁移，或改用演示模式。':
    'The service or data storage check failed. Start the backend, run migrations, or switch to demo mode.',
  '可以完成安装': 'Setup can be completed',
  '完成后会写入站点配置并跳转到管理后台。管理员账户、站点规则与安装时间都会保留。':
    'Finishing writes the site config and opens the dashboard. The administrator account, site rules, and setup time are kept.',
  '站点': 'Site',
  '数据库（记录）': 'Database (recorded)',
  '由后端配置': 'Configured by the backend',
  '模式': 'Mode',
  '演示数据': 'Demo data',
  '无法继续': 'Cannot continue',
  '所有设置都可以在安装后修改。': 'Every setting can be changed after setup.',
  '开始配置': 'Start setup',
  '完成安装': 'Finish setup',
  '登录': 'Sign in',
  '创建管理员': 'Create administrator',
  '继续': 'Continue',
  '、': ', ',
  '12–128 位，且至少包含两类字符（小写、大写、数字、符号），不能是常见弱口令。建议使用长口令。':
    '12–128 characters combining at least two of lowercase, uppercase, digits and symbols; common passwords are refused. A long passphrase is best.',
  // ---- 真实环境：连接阶段 ----
  '连接后端': 'Backend connection',
  '等待本机 API': 'Waiting for the local API',
  '正在等待后端链接': 'Waiting for the backend connection',
  '正在尝试同源接口与本机 8080。启动后端后会自动继续，不需要手动操作。':
    'Trying the same-origin API and local 8080. Setup continues automatically once the backend starts; no manual action is needed.',
  '后端已经连上。': 'The backend is connected.',
  '健康检查已经通过，正在进入数据库设置。':
    'The health check passed; moving on to database settings.',
  '正在检测后端': 'Checking the backend',
  '暂时没有找到后端': 'No backend found yet',
  '后端已找到，等待数据库就绪': 'Backend found; waiting for the database to become ready',
  '准备连接': 'Ready to connect',
  '正在依次探测同源接口与本机 127.0.0.1:8080。':
    'Probing the same-origin API and 127.0.0.1:8080 in turn.',
  '后端一旦可用，这里会自动继续。': 'Setup continues automatically once the backend is available.',
  '立即重试': 'Retry now',
  '已自动尝试 {count} 次，后端启动后会自动继续。':
    'Automatic attempts: {count}. Setup continues as soon as the backend starts.',
  '后端还没有启动': 'The backend is not running yet',
  '。在仓库根目录启动 Go API 后会自动连上；开发时用':
    '. Start the Go API from the repository root and setup connects automatically; in development use',
  // ---- 真实环境：只保留数据库、管理员与站点 ----
  '接下来五步会连上后端、创建第一个管理员、一个默认站点和它的发布规则。所有选项之后都能在管理后台修改。':
    'The next five steps connect the backend, create the first administrator, and define a default site with its publishing rules. Everything can be changed later in the dashboard.',
  '。这段配置要重启 API 才会生效；安装引导只记录你的选择。':
    '. The API must be restarted for this configuration to take effect; setup only records your choice.',
  '填写已有的管理员账户后点「登录」，验证通过会自动进入下一步。':
    'Enter an existing administrator account and choose Sign in; setup advances automatically after it is verified.',
  '填好上面的信息后，点右下角「创建管理员」即可；创建过程会显示进度，完成后自动进入下一步。':
    'Fill in the fields above, then choose Create administrator in the lower right. Progress is shown while the account is created, and setup advances automatically when it finishes.',
  '正在创建管理员': 'Creating the administrator',
  '正在登录管理员账户': 'Signing in the administrator',
  '正在写入账户与站点权限，请稍候。':
    'Writing the account and site permissions. This may take a moment.',
  '正在验证账户并建立会话，请稍候。':
    'Verifying the account and creating a session. This may take a moment.',
  '服务就绪或数据存储未通过。请先启动后端并执行迁移，然后重新检查。':
    'The service or data storage check did not pass. Start the backend, run migrations, and check again.',
  // ---- 字体大小 ----
  字体大小: 'Text size',
  后台与前台字号: 'Backend and frontend text sizes',
  '把字号调到看着舒服。': 'Set text sizes that feel comfortable.',
  '后台是每天工作的地方，前台是读者阅读的地方：两套字号分开调整，互不影响。之后都可以在后台继续修改。':
    'The dashboard is where you work every day and the site is where readers read. The two text sizes are independent, and both can be changed later in the dashboard.',
  后台界面字号: 'Dashboard text size',
  '管理后台的菜单、表单与列表': 'Menus, forms and lists in the dashboard',
  '仪表盘 · 内容库 · 媒体库 · 站点设置':
    'Dashboard · Content · Media library · Site settings',
  '两步上传：先开会话，再传字节，最后由内置安全检查。':
    'Two-step upload: open a session, send the bytes, then the security service checks them.',
  '只影响这台电脑上的管理后台，不影响访客看到的页面。':
    'Only affects the dashboard on this computer; visitors do not see this change.',
  前台正文字号: 'Frontend body text size',
  '文章与自定义页面的正文大小': 'Body text size for articles and custom pages',
  独立出版的账本: 'The ledgers of independent publishing',
  '独立出版最浪漫的部分是「独立」，最不浪漫的部分是「出版」。':
    'The most romantic part of independent publishing is “independent”; the least romantic part is “publishing”.',
  '约 3 分钟阅读': 'About a 3 minute read',
  '影响文章与自定义页面的正文；之后可以在「主题设置 → 主题与版式」里继续调整。':
    'Affects body text in articles and custom pages; you can fine-tune it later under Theme settings → Theme and layout.',
  两处字号互相独立: 'The two text sizes are independent',
  '把后台调大一点更好点按；把前台调大一点更适合长文阅读。访客仍然可以用文章页右侧工具栏临时缩放。':
    'A larger dashboard is easier to click; a larger frontend is easier for long reads. Visitors can still zoom temporarily with the toolbar on the article page.',
  字号: 'Text size',
  '后台 {admin} · 前台正文 {site} px': 'Dashboard {admin} · frontend body {site} px',
};

export default fragment;
