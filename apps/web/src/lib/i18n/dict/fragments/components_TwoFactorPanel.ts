import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/TwoFactorPanel.tsx`（FSD F-04 两步验证） */
const fragment: Dictionary = {
  两步验证: 'Two-factor authentication',
  '登录时除了密码，还需要身份验证器生成的 6 位验证码。可以随时开启或关闭。':
    'Signing in takes your password plus a 6-digit code from an authenticator app. You can turn it on or off at any time.',
  '读取中…': 'Loading…',
  已开启: 'On',
  未开启: 'Off',
  '剩余恢复码 {count} 个': '{count} recovery codes left',
  '绑定于 {date}': 'Enabled on {date}',
  '当前只用密码登录。': 'Only your password is required right now.',
  重新生成恢复码: 'Regenerate recovery codes',
  关闭两步验证: 'Turn off two-factor authentication',
  开启两步验证: 'Turn on two-factor authentication',
  保存恢复码: 'Save your recovery codes',
  复制全部: 'Copy all',
  下载恢复码: 'Download recovery codes',

  // ---- 开启流程 ----
  '用身份验证器扫描二维码，或手动输入下面的密钥，然后填写应用中显示的 6 位验证码。':
    'Scan the QR code with an authenticator app, or type the key below, then enter the 6-digit code it shows.',
  '这些恢复码只显示这一次。每张设备丢失时可以用一个恢复码登录。':
    'These codes are shown only once. If you lose your device, one recovery code signs you in.',
  '需要先验证当前密码。': 'Confirm your current password first.',
  确认开启: 'Confirm and turn on',
  '确认是你本人在操作。': 'Confirms this is really you.',
  两步验证二维码: 'Two-factor QR code',
  '无法扫码？在身份验证器里手动添加：':
    'Cannot scan? Add it manually in your authenticator:',
  复制密钥: 'Copy key',
  '账户名：{account}': 'Account: {account}',
  '演示模式的验证码固定为 {code}。': 'In demo mode the code is always {code}.',
  '6 位验证码': '6-digit code',
  只显示这一次: 'Shown only once',
  '把它保存在离线的地方；同一份恢复码不会被再次展示。':
    'Keep it offline; the same codes are never shown again.',

  // ---- 关闭 / 重新生成 ----
  '关闭后只用密码就能登录。需要当前密码，以及一次有效验证码或恢复码。':
    'After turning it off, your password alone signs you in. Your current password and one valid code or recovery code are required.',
  '旧恢复码会立即作废。需要当前密码，以及一次有效验证码或恢复码。':
    'The old recovery codes stop working immediately. Your current password and one valid code or recovery code are required.',
  确认关闭: 'Confirm and turn off',
  重新生成: 'Regenerate',
  '旧的恢复码已经全部作废。': 'All previous recovery codes have been revoked.',
  验证码或恢复码: 'Code or recovery code',
  '演示模式固定使用 {code}。': 'In demo mode, use {code}.',
  '6 位验证码，或一个恢复码': '6-digit code, or a recovery code',

  // ---- 表单校验与提示 ----
  '请输入当前密码。': 'Enter your current password.',
  '验证码是 6 位数字。': 'The code is 6 digits.',
  '验证码或恢复码不正确。': 'That code or recovery code is not correct.',
  '这个验证码已经用过了，请等下一个。':
    'That code has already been used; wait for the next one.',
  两步验证已开启: 'Two-factor authentication is on',
  '请把恢复码保存到安全的地方。': 'Keep the recovery codes somewhere safe.',
  '请输入当前密码和验证码。': 'Enter your current password and a code.',
  两步验证已关闭: 'Two-factor authentication is off',
  '下次登录只需要密码。': 'The next sign-in only needs your password.',
};

export default fragment;
