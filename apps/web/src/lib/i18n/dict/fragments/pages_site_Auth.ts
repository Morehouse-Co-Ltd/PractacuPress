import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Auth.tsx` */
const fragment: Dictionary = {
  // ---- 文档标题 ----
  管理员登录: 'Admin sign-in',
  登录: 'Sign in',
  注册已关闭: 'Registration closed',
  创建账户: 'Create an account',

  // ---- 个人站点：注册关闭 ----
  '这里不开放注册。': 'Registration is not open here.',
  '{site} 是个人博客，不开放自助注册。账户由站长在后台「用户管理」里创建； 已经有账户的成员可以直接登录。':
    '{site} is a personal blog and does not offer self-service sign-up. Accounts are created by the site owner under Dashboard → Users; members who already have one can sign in directly.',
  回到首页: 'Back to home',
  忘记密码: 'Forgot password',
  '访客无需账户即可阅读全部已发布内容。如果刚完成安装，请使用安装时填写的管理员邮箱进入后台。':
    'Visitors can read everything that has been published without an account. If you have just finished installing, enter the dashboard with the administrator email you provided during setup.',
  '“一个人写，一个人读，也是一种出版。”':
    '“One person writes, one person reads — that is publishing too.”',
  个人博客: 'Personal blog',
  本站: 'this site',

  // ---- 校验与请求错误 ----
  '请填写有效的邮箱地址。': 'Enter a valid email address.',
  '请填写显示名称。': 'Enter a display name.',
  '密码至少 8 位。': 'Passwords must be at least 8 characters.',
  '两次输入的密码不一致。': 'The two passwords do not match.',
  '邮箱或密码不正确。': 'Incorrect email or password.',
  '请求失败。': 'Request failed.',
  '请填写 11 位手机号。': 'Enter an 11-digit phone number.',
  '演示模式的验证码是 {code}。': 'In demo mode the verification code is {code}.',
  '登录失败。': 'Sign-in failed.',

  // ---- 第三方登录 ----
  '{provider}还没有配置完整。请在后台「登录设置」补齐参数。':
    '{provider} is not fully configured yet. Fill in the remaining fields under Dashboard → Sign-in settings.',
  '{provider}登录': '{provider} sign-in',
  '请先获取验证码。': 'Request a verification code first.',
  服务端配置已复制: 'Server configuration copied',
  无法复制: 'Could not copy',
  '请手动选择内容。': 'Please select the content manually.',

  // ---- 标题与引导语 ----
  '回到书房。': 'Back to the study.',
  '回到这间房子。': 'Back to this house.',
  '领一把自己的钥匙。': 'Take a key of your own.',
  '这是 {site} 的管理员入口。站长创建的账户都可以登录；访客不需要登录就能阅读。':
    'This is the admin entrance for {site}. Any account the site owner created can sign in; visitors can read without signing in.',
  '登录 {site}，继续阅读、评论与写作。': 'Sign in to {site} to keep reading, commenting and writing.',
  '注册后可以评论、收藏与投稿。': 'Once registered you can comment, bookmark and submit work.',
  '本站的发布模式是「{mode}」。': 'Publishing on this site is set to “{mode}”.',

  // ---- 表单字段 ----
  显示名称: 'Display name',
  '会出现在文章署名与评论里。': 'Appears in article bylines and comments.',
  '例如：陈默': 'For example: Chen Mo',
  邮箱: 'Email',
  '站长创建的账户都可以登录。': 'Any account created by the site owner can sign in.',
  密码: 'Password',
  '8–128 位。建议使用长口令或密码管理器。':
    '8–128 characters. A long passphrase or a password manager is recommended.',
  '忘记密码？': 'Forgot your password?',
  隐藏: 'Hide',
  显示: 'Show',
  确认密码: 'Confirm password',
  '这个站点还没有配置发信服务（SMTP），找回密码暂时不可用。请联系站长。':
    'This site has not set up outgoing email (SMTP) yet, so password recovery is unavailable. Please contact the site owner.',

  // ---- 第三方登录按钮与演示账户 ----
  或: 'or',
  待配置: 'Not configured yet',
  '演示账户 · 密码统一为 practacu': 'Demo accounts · the password is practacu for all',
  演示验证码已生成: 'Demo verification code generated',
  '真实环境由短信服务商发送；这里固定为 {code}。':
    'In production the SMS provider sends it; here it is always {code}.',

  // ---- 注册 / 登录互跳 ----
  '本站是个人博客，不开放自助注册。需要账户请联系站长创建。':
    'This site is a personal blog and does not offer self-service sign-up. Contact the site owner to have an account created.',
  '还没有账户？': 'No account yet?',
  创建一个: 'Create one',
  '已经有账户？': 'Already have an account?',
  直接登录: 'Sign in here',

  // ---- 侧栏引言 ----
  '“独立不是拒绝平台，而是保留搬走的能力。房子不必大，能遮雨，能招待几个朋友，就够了。”':
    '“Independence is not refusing platforms; it is keeping the ability to move out. The house does not have to be big — enough to keep the rain off and host a few friends.”',
  服务端强制授权: 'Authorization enforced by the server',

  // ---- 第三方登录弹窗 ----
  '演示模式不会真的发送短信或跳转授权页；确认后会以站点管理员身份进入。':
    'Demo mode does not really send an SMS or open an authorization page; confirming signs you in as the site administrator.',
  '服务端实现对应端点后，这个入口才能真正完成登录。':
    'This entrance can only complete a real sign-in once the server implements the matching endpoint.',
  模拟授权并继续: 'Simulate authorization and continue',
  复制服务端配置: 'Copy server configuration',
  手机号: 'Phone number',
  验证码: 'Verification code',
  重新获取: 'Resend',
  获取验证码: 'Get code',
  '6 位数字': '6 digits',
  演示验证码: 'Demo verification code',
  请输入: 'Enter',
  '。真实环境由短信服务商下发，前端不保存验证码。':
    '. In production the SMS provider issues it; the front end never stores it.',
  等待服务端实现: 'Waiting for the server',
  '契约 v0.1.0 没有这个登录端点。服务端实现':
    'Contract v0.1.0 has no such sign-in endpoint. Once the server implements',
  '后，前端才能把用户交给提供商并接收回调。':
    'the front end can hand the user to the provider and receive the callback.',
};

export default fragment;
