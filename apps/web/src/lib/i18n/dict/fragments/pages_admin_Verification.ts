import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Verification.tsx` */
const fragment: Dictionary = {
  人机验证: 'Bot protection',
  '人机验证设置已保存': 'Bot protection settings saved',
  '已启用 {provider}；前台对应表单会显示验证组件。':
    'Enabled {provider}; the matching forms on the site now show the verification widget.',
  '人机验证已关闭，前台表单恢复原样。': 'Bot protection is off; site forms are back to normal.',
  '已恢复默认人机验证': 'Default bot protection restored',
  '关闭验证并回到 Cloudflare Turnstile。':
    'Verification is off and Cloudflare Turnstile is selected again.',
  站点管理员: 'Site admin',
  '用 CAPTCHA 保护登录、注册与评论；密钥只用于生成服务端环境变量，不写入浏览器配置。':
    'Protect sign-in, sign-up, and comments with a CAPTCHA; keys are only used to generate server environment variables and are never written to browser configuration.',
  '前端只负责显示组件': 'The front end only renders the widget',
  '契约 v0.1.0 没有验证端点：本页保存的是站点侧配置意图。接入真实后端时，需要服务端提供':
    'Contract v0.1.0 has no verification endpoint, so this page stores the site-side configuration intent. With a real backend, the server must provide',
  '校验 token，并在登录 / 注册 / 评论接口上强制校验。':
    'to validate tokens, and enforce validation on the sign-in / sign-up / comment endpoints.',

  验证服务: 'Verification service',
  '选择服务商并填写前端可见的 Site Key。':
    'Choose a provider and enter the Site Key that the front end can see.',
  已启用: 'Enabled',
  未启用: 'Not enabled',
  '启用站点人机验证': 'Enable bot protection on this site',
  '关闭时下面的服务与场景配置会保留，但前台不会显示验证组件。':
    'When it is off, the provider and scenario settings below are kept, but the site does not render the widget.',
  服务商: 'Provider',
  '三家都使用同样的前端挂载方式，切换只影响脚本与密钥。':
    'All three mount the same way in the front end; switching only changes the script and the keys.',
  '会写进页面脚本，可以公开；不要填 Secret。':
    'Written into the page script and safe to publish; do not enter the Secret here.',
  '只用于生成服务端环境变量，不保存到安装配置。':
    'Only used to generate server environment variables; never saved to the installation config.',
  仅本次: 'This session only',
  '服务端保存的密钥': 'Key stored on the server',
  '登录时验证': 'Verify on sign-in',
  '邮箱密码登录与第三方登录入口。':
    'Email and password sign-in, plus the third-party sign-in entry points.',
  '注册时验证': 'Verify on sign-up',
  '评论时验证': 'Verify on comments',
  '发评论与回复前验证；已经登录的读者也会被检查。':
    'Verify before commenting or replying; signed-in readers are checked too.',

  '免费、无感，推荐海外站点使用。':
    'Free and invisible; recommended for sites outside mainland China.',
  '隐私友好，可配置难度与主题。': 'Privacy friendly; difficulty and theme are configurable.',
  '兼容性最好，国内访问可能受限。':
    'Best compatibility, but access from mainland China may be limited.',
  登录: 'Sign-in',
  注册: 'Sign-up',
  评论: 'Comment',
  '密码登录与第三方登录入口前验证。':
    'Verify before the password sign-in and third-party sign-in entry points.',
  '阻止批量注册与脚本注册。': 'Blocks bulk sign-ups and scripted sign-ups.',
  '发评论、回复与点赞前验证。': 'Verify before commenting, replying, or reacting.',

  服务端环境变量: 'Server environment variables',
  '交给服务端后由后端在对应接口上校验 token。':
    'Hand it to the server; the backend then validates tokens on the matching endpoints.',
  '复制 .env': 'Copy .env',
  '（已填写，仅本次）': '(filled in, this session only)',
  '（服务端保存）': '(stored on the server)',
  '密钥不会写入 localStorage；这里的片段只用于粘贴到服务端环境变量。':
    'Keys are never written to localStorage; this snippet is only meant to be pasted into the server environment variables.',

  当前状态: 'Current status',
  '保存后才在前台生效。': 'It applies on the site only after saving.',
  已填写: 'Provided',
  未填写: 'Not provided',
  保护场景: 'Protected scenarios',
  无: 'None',
  服务端: 'Server',
  待接入校验端点: 'Verification endpoint not connected yet',

  '恢复默认人机验证': 'Restore default bot protection',
  '关闭验证并回到 Cloudflare Turnstile；不会影响文章、评论或访问限制。':
    'Turns verification off and returns to Cloudflare Turnstile; articles, comments, and access limits are untouched.',
  恢复默认: 'Restore defaults',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
};

export default fragment;
