import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/LoginSettings.tsx` */
const fragment: Dictionary = {
  '登录设置': 'Sign-in settings',
  '站点管理员': 'Site admin',
  '点击上方五种登录方式切换配置；每种方式只显示自己的参数。':
    'Click one of the five sign-in methods above to switch configuration; each method only shows its own parameters.',
  '返回站点设置': 'Back to site settings',
  '登录方式': 'Sign-in methods',
  邮箱与密码: 'Email and password',
  '基础登录方式，含邮件通知与找回密码。':
    'The base sign-in method, with email notifications and password recovery.',
  已启用: 'Enabled',
  '已配置，登录页会显示入口。': 'Configured; the sign-in page shows an entry point.',
  '未启用。': 'Not enabled.',
  '始终可用；注册、登录与找回密码都依赖它。':
    'Always available; sign-up, sign-in, and password recovery all rely on it.',
  '邮箱 + 密码': 'Email + password',
  令牌: 'Token',
  防跨站: 'CSRF protection',
  'CSRF 双提交': 'CSRF double submit',
  邮件通知: 'Email notifications',
  '找回密码靠邮件发出一次性链接；没有 SMTP 就没有找回密码。':
    'Password recovery sends a one-time link by email; without SMTP there is no password recovery.',
  演示模式: 'Demo mode',
  服务端已连通: 'Server connected',
  服务端未配置: 'Server not configured',
  '这一栏记录的是站点侧的配置意图，真正能否发信由服务端环境变量决定。':
    'This section records the configuration intent on the site side; whether mail can really be sent is decided by the server environment variables.',
  '下面的片段复制到 .env 后重启 API，徽章会变成「服务端已连通」。':
    'Copy the snippet below into .env and restart the API, and the badge turns into “Server connected”.',
  未启用: 'Not enabled',
  '登录页只显示必填项完整的方式。连接真实后端时，对应端点需要由服务端实现；演示模式可以直接模拟授权。':
    'The sign-in page only shows methods whose required fields are all filled in. With a real backend, the matching endpoints must be implemented on the server; demo mode can simulate authorization directly.',
  服务端环境变量: 'Server environment variables',
  '五种方式共用；密钥只用于拼接片段，不会写入浏览器配置。':
    'Shared by all five methods; secrets are only used to build the snippet and are never written to the browser configuration.',
  含本次填写密钥: 'Includes secrets entered here',
  '复制 .env': 'Copy .env',
  密钥不经过前端保存: 'Secrets are never saved by the front end',
  '浏览器的 localStorage 对同域脚本可读。Client Secret、短信 AccessSecret 与 JWT':
    'The browser’s localStorage is readable by same-origin scripts. A Client Secret, an SMS AccessSecret, or a JWT',
  '私钥只应该存在于服务端环境变量，这里填写的值仅用于拼接上面的片段。':
    'private key belongs only in the server environment variables; the values entered here are used only to build the snippet above.',
};

export default fragment;
