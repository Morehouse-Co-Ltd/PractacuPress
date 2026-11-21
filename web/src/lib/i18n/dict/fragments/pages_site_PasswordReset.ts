import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/site/PasswordReset.tsx` */
const fragment: Dictionary = {
  // ---- 侧栏注脚 ----
  '“忘记密码是常事。能自己找回来，才算一间待客的房子。”':
    '“Forgetting a password is normal. Being able to find your own way back is what makes a house that welcomes guests.”',
  个人博客: 'Personal blog',
  社区站点: 'Community site',
  '一次性链接 · 30 分钟': 'Single-use link · 30 minutes',
  成功后其他设备退出: 'Other devices are signed out afterwards',

  // ---- 请求错误 ----
  '服务端还没有配置 SMTP，暂时无法发送邮件。请联系站长。':
    'The server has no SMTP configured yet, so email cannot be sent. Please contact the site owner.',
  '请求过于频繁，请稍后再试。': 'Too many requests. Please try again later.',
  '请求失败，请稍后再试。': 'The request failed. Please try again later.',

  // ---- 找回密码：标题与引导语 ----
  找回密码: 'Reset password',
  '找回密码。': 'Reset your password.',
  '填写账户邮箱，我们会发一封带一次性链接的邮件。链接 {minutes} 分钟内有效，只能使用一次。':
    'Enter your account email and we will send a message with a single-use link. The link stays valid for {minutes} minutes and can be used only once.',

  // ---- 找回密码：未配置发信服务 ----
  '这个站点还没有配置发信服务': 'This site has not set up outgoing email yet',
  '服务端需要先填写 SMTP 主机、端口与发信账号，找回密码才能真正发出邮件。 如果你就是站长，可以到「管理后台 → 登录设置 → 邮件通知」生成配置片段。':
    'The server needs an SMTP host, port and sending account before password reset can really send mail. If you are the site owner, go to Dashboard → Sign-in settings → Email notifications to generate a configuration snippet.',

  // ---- 找回密码：已发送 ----
  '如果这个邮箱已注册，邮件已经发出': 'If this email is registered, the message has been sent',
  '没有收到？先看看垃圾邮件目录；邮件可能延迟一两分钟。出于安全考虑，我们不会告诉你这个邮箱是否存在。':
    'Nothing arrived? Check the spam folder first; delivery can take a minute or two. For security we do not reveal whether this email exists.',
  '演示模式不会真的发邮件 · 直接用下面的链接继续':
    'Demo mode does not really send email · use the link below to continue',
  '打开重置链接': 'Open the reset link',
  回到登录: 'Back to sign in',
  '换一个邮箱': 'Use a different email',

  // ---- 找回密码：表单 ----
  邮箱: 'Email',
  '就是登录时使用的那个邮箱。': 'The same email you use to sign in.',
  '请填写有效的邮箱地址。': 'Enter a valid email address.',
  '发送重置链接': 'Send reset link',
  '想起来了？': 'Remembered it?',
  直接登录: 'Sign in here',

  // ---- 设置新密码：标题与校验 ----
  '设置新密码': 'Set a new password',
  '设置新密码。': 'Set a new password.',
  '密码至少 12 位。': 'Passwords must be at least 12 characters.',
  '两次输入的密码不一致。': 'The two passwords do not match.',
  '这个链接已经用过，或者过期了。请重新申请一封邮件。':
    'This link has already been used or has expired. Please request another email.',

  // ---- 设置新密码：成功 ----
  '密码已更新。': 'Password updated.',
  '密码已经更新。为了安全，这个账户之前登录的设备都已退出。':
    'Your password has been updated. For security, every device previously signed in to this account has been signed out.',
  可以继续使用了: 'You can continue now',
  '用新密码重新登录即可。之后如果又想改密码，重复一遍找回流程就好。':
    'Just sign in again with the new password. If you want to change it later, go through the reset flow once more.',
  去登录: 'Go to sign in',
  回到首页: 'Back to home',

  // ---- 设置新密码：链接失效 ----
  '链接不能用了。': 'This link no longer works.',
  '这个重置链接没法使用了。': 'This reset link can no longer be used.',
  '链接无效或已过期': 'The link is invalid or has expired',
  '重置链接只能使用一次，并且 30 分钟后失效。重新申请一封邮件就可以了。':
    'A reset link works only once and expires after 30 minutes. Request another email and you are set.',
  重新申请: 'Request again',

  // ---- 设置新密码：表单 ----
  '选一个新密码。设置成功后，这个账户在所有设备上的登录都会失效。':
    'Choose a new password. Once it is set, this account is signed out everywhere.',
  新密码: 'New password',
  '12–128 位，至少两类字符且不能是常见弱口令。建议使用长口令或密码管理器。':
    '12–128 characters with at least two character classes; common passwords are refused. A long passphrase or a password manager is recommended.',
  隐藏: 'Hide',
  显示: 'Show',
  确认新密码: 'Confirm new password',
  更新密码: 'Update password',
  返回登录: 'Back to sign in',
  '重新申请链接': 'Request a new link',
  '需要帮助？联系站点管理员。': 'Need help? Contact the site administrator.',
  '请填写新密码。': 'Enter the new password.',
};

export default fragment;
