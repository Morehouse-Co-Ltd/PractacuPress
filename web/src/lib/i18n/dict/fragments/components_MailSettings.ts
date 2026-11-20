import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/MailSettings.tsx` */
const fragment: Dictionary = {
  // ---- 卡片头部与状态 ----
  找回密码邮件: 'Password reset email',
  '用户忘记密码时，服务端通过 SMTP 发出一封一次性链接。':
    'When a user forgets their password, the server sends a one-time link over SMTP.',
  演示模式: 'Demo mode',
  服务端已就绪: 'Server ready',
  待服务端配置: 'Waiting for server settings',
  待补齐: 'Incomplete',
  未启用: 'Not enabled',
  启用找回密码: 'Enable password reset',

  // ---- 表单字段 ----
  'SMTP 主机': 'SMTP host',
  '例如 smtp.qq.com、smtp.gmail.com、mail.example.com。':
    'For example smtp.qq.com, smtp.gmail.com, or mail.example.com.',
  加密方式: 'Encryption',
  端口: 'Port',
  '留空按加密方式取默认值（当前 {port}）。':
    'Leave blank to use the default for the encryption method (currently {port}).',
  发件地址: 'From address',
  '多数服务商要求与登录账号一致。':
    'Most providers require this to match the sign-in account.',
  登录账号: 'Sign-in account',
  '没有认证的内网中继可以留空。':
    'Can be left blank for an internal relay without authentication.',
  '登录密码 / 授权码': 'Password / app password',
  '只用于生成服务端环境变量，不写入浏览器配置。':
    'Only used to generate server environment variables; never written to browser configuration.',
  仅本次: 'This session only',
  'SMTP 授权码': 'SMTP app password',
  发件人名称: 'Sender name',
  站点地址: 'Site address',
  '绝对链接的前缀；留空时服务端按 https 假定，桌面 / localhost（http）请显式填写。':
    'Prefix for absolute links; when blank the server assumes https, so a desktop / localhost (http) install must fill it in.',

  // ---- 端点与提示 ----
  // 这里的英文末尾留一个空格：后面紧跟 <code> 里的接口路径。
  '服务端端点：': 'Server endpoint: ',
  '演示模式：不会真的发信': 'Demo mode: no real email is sent',
  服务端已能发出找回密码邮件: 'The server can send password reset emails now',
  还需要把配置写进服务端: 'The settings still need to reach the server',
  '演示模式的「忘记密码」完全在本地完成，不会真的发信。把上面的片段交给正式服务端后，登录页就会走真实邮件。':
    'In demo mode, "Forgot password" runs entirely in the browser and no email is sent. Hand the snippet above to a real server and the sign-in page switches to real email.',
  '服务端已经连上 SMTP。登录页会显示「忘记密码」入口，重置链接 30 分钟内有效。':
    'The server is connected to SMTP. The sign-in page shows a "Forgot password" entry, and reset links stay valid for 30 minutes.',
  '把下面的环境变量写进服务端并重启 API，找回密码入口就会出现。在这之前，登录页会提示暂不可用。':
    'Write the environment variables below into the server and restart the API to reveal the password reset entry. Until then the sign-in page reports it as unavailable.',

  // ---- 服务端环境变量片段 ----
  服务端环境变量: 'Server environment variables',
  '复制到 .env（或进程环境变量）；重启 API 后生效。':
    'Copy into .env (or the process environment); restart the API to apply.',
  '复制 .env': 'Copy .env',
  收起: 'Collapse',
  展开: 'Expand',
  密码不经过前端保存: 'Passwords are never stored by the front end',
  'SMTP 授权码与 JWT 私钥一样只应该存在于服务端环境变量。这里填写的值仅用于拼接上面的片段，页面刷新后就没了。':
    'Like a JWT private key, the SMTP app password should only live in server environment variables. The values entered here are only used to build the snippet above and are gone once the page is refreshed.',
};

export default fragment;
