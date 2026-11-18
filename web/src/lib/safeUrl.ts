/**
 * 用户填写的链接地址白名单。
 *
 * 页面编排里的图片、视频、按钮、网站卡片都会把地址写进 `href` / `src`。
 * 这里只放行两种：
 * - `http://` / `https://` 的绝对地址；
 * - 以 `/` 开头的站内绝对路径（例如 `/articles`、`/media/x.png`）。
 *
 * 其余一律返回空串：`javascript:`、`data:`、`//host`（协议相对地址会跳出当前
 * 协议）、`mailto:` 之类都不在页面编排的支持范围内。空串由调用方渲染成
 * 「未填写 / 不可点击」，而不是一个可被利用的链接。
 */
export function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  // 只放行「/ 开头但不是 // 开头」的站内绝对路径；`//evil.example.com` 会被
  // 浏览器当成协议相对的外链，必须挡掉。
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  return '';
}

/** 是否是外部 http(s) 地址（决定要不要 `target="_blank"` + `noopener`）。 */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
