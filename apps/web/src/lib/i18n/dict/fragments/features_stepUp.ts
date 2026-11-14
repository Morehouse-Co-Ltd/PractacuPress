import type { Dictionary } from '../../plural';

/**
 * 来源：高威胁操作二次验证（step-up）相关文件：
 * `components/StepUpModal.tsx`、`lib/stepUp.ts`、`lib/backend.tsx`（演示后端）、
 * `pages/Setup.tsx`（安全步骤）、`pages/admin/Settings.tsx`、`pages/admin/Members.tsx`、
 * `pages/admin/Data.tsx`。
 */
const fragment: Dictionary = {
  // ---- 弹窗 ----
  再次输入密码: 'Enter your password again',
  '这是高威胁操作，需要再次验证身份。': 'This is a high-risk action. Confirm your identity again.',
  '验证并继续': 'Verify and continue',
  '即将执行：{action}': 'About to run: {action}',
  '可以用账户登录密码；站点设置了专用安全密码时，请使用专用安全密码。':
    'Use your account password, or the dedicated security password if the site has one.',
  '请输入密码。': 'Enter your password.',
  '验证没有通过': 'Verification failed',
  '验证一次后，本次浏览器会话内的高危操作不再重复询问；关闭浏览器后需要重新验证。':
    'Verify once and high-risk actions in this browser session will not ask again. Closing the browser requires a new verification.',
  '演示模式不校验二次密码': 'Demo mode does not check a second password',
  '演示数据没有服务端安全校验，高危操作会直接执行；连接真实后端后才会真正要求验证。':
    'Demo data has no server-side security checks, so high-risk actions run directly. Verification is only enforced against a real backend.',

  // ---- Provider / 演示后端 ----
  '后端还没有提供二次验证端点（HTTP {status}）。请确认 API 已更新后重试。':
    'The API does not expose the step-up endpoint yet (HTTP {status}). Update the API and try again.',
  '演示模式不保存专用密码': 'Demo mode does not store a dedicated password',
  '演示模式不保存专用密码；连接真实后端后再设置，或直接使用账户登录密码。':
    'Demo mode does not store a dedicated password. Set one after connecting a real backend, or use your account password.',
  '演示模式没有服务端安全校验，无法验证密码；连接真实后端后才会真正校验。':
    'Demo mode has no server-side security checks, so passwords cannot be verified. Verification only happens against a real backend.',

  // ---- 安装引导：安全步骤 ----
  安全: 'Safety',
  高威胁操作保护: 'High-risk action protection',
  '给高危操作加一道门。': 'Put a gate in front of high-risk actions.',
  '删除用户、修改别人的账户、覆盖导入这类操作一旦点错就很难挽回。开启保护后，执行前需要再输入一次密码。':
    'Deleting users, editing other accounts and overwriting imports are hard to undo. With protection on, you must enter your password first.',
  '开启高威胁操作保护': 'Enable high-risk action protection',
  '关闭高威胁操作保护': 'Disable high-risk action protection',
  '默认开启。关闭后，高危操作会直接执行，不再要求二次验证。':
    'On by default. When off, high-risk actions run directly with no second check.',
  '专用安全密码（可选）': 'Dedicated security password (optional)',
  '留空则使用你的账户登录密码。设置后验证只接受这个专用密码；至少 8 位。':
    'Leave blank to use your account password. Once set, only this dedicated password is accepted; at least 8 characters.',
  '确认专用安全密码': 'Confirm dedicated security password',
  '专用安全密码至少 8 位。': 'The dedicated security password must be at least 8 characters.',
  '两次输入的安全密码不一致。': 'The two security passwords do not match.',
  '这个设置之后可以修改': 'You can change this later',
  '安装完成后，可以在「站点设置 → 高威胁操作保护」里开关保护、设置或清除专用密码。':
    'After installation, open Site settings → High-risk action protection to toggle protection and set or clear the dedicated password.',
  '保护设置没有保存成功': 'Protection settings were not saved',
  '可以重试；也可以先跳过这一步完成安装，之后在站点设置里重新配置。':
    'Retry, or skip this step to finish installing and configure it later in Site settings.',
  '跳过这一步，稍后配置': 'Skip this step and configure later',
  '接下来几步会连上后端、创建第一个管理员、设置高威胁操作保护，再创建默认站点和发布规则。所有选项之后都能在管理后台修改。':
    'The next few steps connect the backend, create the first administrator, set up high-risk action protection, then create the default site and its publishing rules. Everything can be changed later in the dashboard.',
  '{count} 步': '{count} steps',
  '已开启（专用安全密码）': 'On (dedicated security password)',
  '已开启（账户登录密码）': 'On (account password)',
  '已开启（稍后写入）': 'On (will be saved later)',

  // ---- 后台设置面板 ----
  '删除用户、修改别人的账户、覆盖导入等重要操作前，需要再输入一次密码；同一次浏览器会话内只验证一次。':
    'Deleting users, editing other accounts and overwriting imports require your password again; once per browser session.',
  '本次浏览器会话内有效；关闭浏览器后重新验证':
    'Valid for this browser session; verify again after closing the browser',
  '正在读取保护设置…': 'Reading protection settings…',
  '无法读取或保存保护设置': 'Could not read or save protection settings',
  重新读取: 'Reload',
  '验证窗口 {seconds} 秒': 'Verification window: {seconds}s',
  '已设置专用安全密码': 'Dedicated security password set',
  '验证使用账户登录密码': 'Verification uses the account password',
  '开启后，删除账户、修改其他成员、覆盖导入等操作前会要求再次输入密码；关闭后这些操作直接执行。':
    'When on, deleting accounts, editing other members and overwriting imports require your password again; when off they run directly.',
  '演示模式没有服务端安全校验：开关会保存在本地，高危操作会直接执行；专用密码不可用。连接真实后端后才会真正校验。':
    'Demo mode has no server-side security checks: the switch is saved locally, high-risk actions run directly, and the dedicated password is unavailable. Real verification only happens against a real backend.',
  '留空表示不修改。设置后验证只接受这个专用密码；清除后恢复使用账户登录密码。至少 8 位。':
    'Leave blank to keep the current value. Once set, only this dedicated password is accepted; clearing it restores the account password. At least 8 characters.',
  '更换专用密码': 'Change dedicated password',
  '设置专用密码': 'Set dedicated password',
  '清除专用密码': 'Clear dedicated password',
  '高威胁操作保护已更新': 'High-risk action protection updated',
  '保护已开启：高危操作前会要求再次输入密码。':
    'Protection is on: high-risk actions will ask for your password again.',
  '保护已关闭：高危操作会直接执行。': 'Protection is off: high-risk actions run directly.',
  '无法保存高威胁操作保护': 'Could not save high-risk action protection',
  '请填写专用安全密码。': 'Enter the dedicated security password.',
  '更换专用安全密码': 'Change the dedicated security password',
  '设置专用安全密码': 'Set the dedicated security password',
  '清除专用安全密码': 'Clear the dedicated security password',
  切换站点形态: 'Switch site type',

  // ---- 高危操作动作名（弹窗里回显） ----
  删除成员账户: 'Delete member account',
  调整成员用户组: 'Change member group',
  创建成员账户: 'Create member account',
  编辑成员资料: 'Edit member profile',
  修改成员状态: 'Change member status',
  修改成员媒体额度: 'Change member media quota',
  重置成员两步验证: 'Reset member two-factor authentication',
  覆盖导入站点数据: 'Overwrite site import',
  导入站点数据: 'Import site data',
  删除敏感词: 'Delete sensitive word',
  '删除 IP 规则': 'Delete IP rule',

  // ---- 用户管理：重置两步验证 ----
  '重置两步验证': 'Reset two-factor',
  '清除该成员的两步验证，方便丢失设备后重新绑定':
    'Clear this member’s two-factor setup so they can re-enroll after losing a device',
  '已重置两步验证': 'Two-factor reset',
  '{name} 下次登录时不再需要两步验证码。': '{name} will no longer need a two-factor code on the next sign-in.',
  '无法重置两步验证': 'Could not reset two-factor authentication',
};

export default fragment;
