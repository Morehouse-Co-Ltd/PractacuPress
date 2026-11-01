/**
 * 站点设置（访问限制、域名、性能、加载动画）共用的取值与收敛函数。
 *
 * 这些设置和主题一样保存在 `pp.web.config.v1` 里。旧配置缺字段、导入文件夹带
 * 错误类型时，一律回到安全默认值，绝不让一个坏字段把整个后台打不开。
 */

export function settingText(value: unknown, fallback: string, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

export function settingBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function settingInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function settingHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())
    ? value.trim()
    : fallback;
}

/** 字符串列表：去空、去重、截断；保持输入顺序。 */
export function settingList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}
