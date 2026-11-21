/** 内容地址（slug）允许的最大长度，与服务端和数据库列宽一致。 */
export const CONTENT_SLUG_MAX_LENGTH = 120;

const SLUG_RUNE = /[\p{L}\p{N}\p{M}]/u;
const SLUG_PATTERN = /^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$/u;

/**
 * 从句标题生成内容地址。
 *
 * 保留原文使用的文字，而不是转写成拼音：中文标题继续是中文，空格和标点折叠
 * 为一个连字符，拉丁字母转小写。这样默认地址就是「文章名」，也不会因为不同
 * 汉字被转写成同一个拼音而撞地址。标题只有表情或标点时返回空串，调用方继续
 * 使用按 id 的旧地址。
 */
export function contentSlugFromTitle(title: string): string {
  let slug = '';
  let separator = false;

  for (const rune of title.toLowerCase()) {
    if (SLUG_RUNE.test(rune)) {
      if (separator && slug) slug += '-';
      slug += rune;
      separator = false;
    } else {
      separator = true;
    }
  }

  const runes = [...slug];
  const bounded = runes.length > CONTENT_SLUG_MAX_LENGTH
    ? runes.slice(0, CONTENT_SLUG_MAX_LENGTH).join('')
    : slug;
  return bounded.replace(/-+$/, '');
}

/** 校验用户手动输入的内容地址；服务端会自行转小写并去掉首尾空白。 */
export function isValidContentSlug(value: string): boolean {
  const slug = value.trim();
  return slug.length > 0 && [...slug].length <= CONTENT_SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}
