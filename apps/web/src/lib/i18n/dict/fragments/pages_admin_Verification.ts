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
  '每次邮箱密码登录。两步验证的第二步只在登录接口上校验一次。':
    'Every email and password sign-in. The second two-factor step is checked once, on the sign-in endpoint.',
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
  '邮箱密码登录前验证。': 'Verify before an email and password sign-in.',
  '阻止批量注册与脚本注册。': 'Blocks bulk sign-ups and scripted sign-ups.',
  '发评论与回复前验证。': 'Verify before posting a comment or a reply.',

  服务端环境变量: 'Server environment variables',
  '交给服务端后由后端在对应接口上校验 token。':
    'Hand it to the server; the backend then validates tokens on the matching endpoints.',
  '复制 .env': 'Copy .env',
  '（已填写，仅本次）': '(filled in, this session only)',
  '（服务端保存）': '(stored on the server)',
  '密钥不会写入 localStorage；这里的片段只用于粘贴到服务端环境变量。':
    'Keys are never written to localStorage; this snippet is only meant to be pasted into the server environment variables.',

  当前状态: 'Current status',
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

  // ---- 横向「当前状态」卡组 ----
  '按当前编辑实时汇总，保存后对站点生效。':
    'Summarised from the current edits; saving applies it to the site.',
  '当前验证服务': 'Current verification service',
  '站点级开关': 'Site-level switch',
  '前端可见': 'Visible in the browser',
  '登录 / 注册 / 评论': 'Sign-in / sign-up / comments',
  '契约 v0.1.0': 'Contract v0.1.0',
  // ---- 真实服务端状态 ----
  '用 CAPTCHA 保护登录、注册、找回密码与评论；密钥只保存在服务端环境变量。':
    'Protect sign-in, sign-up, password reset, and comments with a CAPTCHA; the secret lives only in the server environment.',
  校验发生在接口上: 'The check runs on the API endpoints',
  '人机验证由登录、注册、找回密码与评论接口执行；验证 token 只能使用一次，所以没有单独的校验端点。开启后前台表单会显示对应服务商的组件，服务端没有 Secret 时不会校验、也不会显示组件。':
    'Sign-in, sign-up, password reset, and comment endpoints enforce the challenge. A token is single use, so there is no separate verify endpoint. When it is on, the matching form renders the provider widget; without a server secret nothing is checked and no widget is shown.',
  '服务端还没有这个服务商的密钥': 'The server has no key for this provider',
  '把下面片段里的 {env} 加进服务端环境变量并重启，验证才会真正生效；在此之前前台不会显示组件。':
    'Add {env} from the snippet below to the server environment and restart; until then the site renders no widget.',
  '按当前编辑实时汇总；服务端一栏读取的是真实配置。':
    'Summarised from the current edits; the server card reads the real deployment state.',
  校验已生效: 'Enforced',
  刷新状态: 'Refresh status',
  待配置密钥: 'Waiting for a secret',
  '配置已保存，但服务端还没有 {provider} 的 Secret，暂时不会校验。':
    'Saved, but the server has no {provider} secret yet, so nothing is verified for now.',
  'reCAPTCHA 模式': 'reCAPTCHA mode',
  'v2 显示复选框，兼容性最好；v3 无感评分，需要服务端设置分数阈值。':
    'v2 shows a checkbox and works everywhere; v3 scores invisibly and needs a server-side score threshold.',
  '可见复选框，token 由用户点击产生。': 'A visible checkbox; the token comes from the visitor.',
  '无感执行，按场景 action 取 token，低分会被服务端拒绝。':
    'Runs invisibly, requests a token per scene action, and the server rejects low scores.',
  '不会保存；只用来生成下面的服务端环境变量片段。':
    'Never saved; only used to build the server environment snippet below.',
  找回密码时验证: 'Verify on password reset',
  '发送重置链接前验证，避免被用来刷邮件。':
    'Challenge the "send reset link" step so it cannot be used to flood mail.',
  '发送重置链接前验证。': 'Verify before a reset link is sent.',
  '复制到服务端并重启后，接口才会真正校验 token。':
    'The API only verifies tokens after this is copied to the server and the process restarts.',
  'Site Key 随站点设置保存在服务端文档里；只有 Secret 走环境变量。组件脚本从服务商 CDN 加载，离线或网络受限时显示不出来，表单会给出可读提示。':
    'The Site Key is saved with the site settings on the server; only the Secret comes from the environment. Widget scripts load from the provider CDN, so on an offline or restricted network the form shows a readable notice instead of the widget.',
  '正在读取服务端状态…': 'Reading the server state…',
  已配置密钥: 'Key configured',
  未配置密钥: 'No key configured',
  读取失败: 'Could not read',
  读不到服务端状态: 'Server state unavailable',
  '服务端没有回答人机验证状态；自动保存仍然可用，但这里无法确认校验是否真的生效。请稍后点「刷新状态」。':
    'The server did not report its verification state. Auto-save still works, but this page cannot confirm the check runs; try "Refresh status" again shortly.',
  按服务端实际配置: 'From the real server state',
  '登录 / 注册 / 评论 / 找回密码': 'Sign-in / sign-up / comments / password reset',
};

export default fragment;
