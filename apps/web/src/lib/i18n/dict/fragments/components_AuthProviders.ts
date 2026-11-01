import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/AuthProviders.tsx` */
const fragment: Dictionary = {
  // ---- 登录方式卡片状态 ----
  已配置: 'Configured',
  待补齐: 'Incomplete',
  未启用: 'Not enabled',
  '启用{name}登录': 'Enable {name} sign-in',

  // ---- 字段与端点 ----
  '只用于生成服务端环境变量，不写入浏览器配置。':
    'Only used to generate server environment variables; never written to browser configuration.',
  仅本次: 'This session only',
  // 这里的英文末尾留一个空格：后面紧跟 <code> 里的接口路径。
  '服务端端点：': 'Server endpoint: ',
  '填写带 * 的必填项后，前台登录页才会显示这个入口。':
    'This entry appears on the sign-in page only after the required fields marked * are filled in.',

  // ---- 服务端环境变量片段 ----
  服务端环境变量: 'Server environment variables',
  '演示模式不会真的发短信或跳转 OAuth；这份片段用于之后连接真实后端。':
    'Demo mode never sends a real SMS or redirects to OAuth; this snippet is for connecting a real backend later.',
  '把这些值交给服务端；密钥留空时会显示占位符，不会被保存。':
    'Hand these values to the server; blank secrets show as placeholders and are never saved.',
  '复制 .env': 'Copy .env',
  收起: 'Collapse',
  展开: 'Expand',
  密钥不经过前端保存: 'Secrets are never stored by the front end',
  '浏览器的 localStorage 对同域脚本可读。Client Secret、短信 AccessSecret 与 JWT 私钥只应该存在于服务端环境变量， 这里填写的值仅用于拼接上面的片段。':
    'Browser localStorage is readable by scripts on the same origin. Client secrets, SMS AccessSecrets, and JWT private keys should only live in server environment variables; the values entered here are only used to build the snippet above.',
};

export default fragment;
