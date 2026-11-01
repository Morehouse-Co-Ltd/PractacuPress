/**
 * 站点语言清单。
 *
 * 只有两种：简体中文与英文。新增语言时在这里加一项、在 `dict/` 里加一张表即可，
 * 其余代码只依赖 `Locale` 类型与 `normalizeLocale`。
 */

export type Locale = 'zh-CN' | 'en';

/** 站点语言只能在这两种之间切换；旧配置缺省、非法值一律回退中文。 */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export interface LocaleOption {
  id: Locale;
  /** 语言自己的名字：切换器上永远用这个，不随界面语言变化。 */
  native: string;
  /** 另一种语言里的叫法，用于「当前语言」这类说明。 */
  english: string;
}

export const LOCALES: readonly LocaleOption[] = [
  { id: 'zh-CN', native: '简体中文', english: 'Chinese (Simplified)' },
  { id: 'en', native: 'English', english: 'English' },
];

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
