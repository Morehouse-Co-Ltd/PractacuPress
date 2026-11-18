/**
 * 图片区块的圆角预设。
 *
 * 「跟随主题」不写死像素：由 styles.css 按布局变体决定（经典单栏用主题的
 * --r-lg，夜航双栏则与首屏两张 16px 大卡、卡片底座保持一致），这样换主题
 * 时图片不需要重新设置。其余档位是明确的像素值，直接在图片上内联。
 */
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

export type ImageRadius = 'theme' | 'none' | 'sm' | 'md' | 'lg' | 'xl';

const RAW_IMAGE_RADIUS_OPTIONS: { value: ImageRadius; label: string }[] = [
  { value: 'theme', label: t('跟随主题') },
  { value: 'none', label: t('直角（0）') },
  { value: 'sm', label: t('小圆角（8px）') },
  { value: 'md', label: t('中圆角（12px）') },
  { value: 'lg', label: t('大圆角（16px）') },
  { value: 'xl', label: t('超大圆角（24px）') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const IMAGE_RADIUS_OPTIONS = liveCatalog(RAW_IMAGE_RADIUS_OPTIONS);

const RADIUS_PX: Record<Exclude<ImageRadius, 'theme'>, string> = {
  none: '0px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
};

const KNOWN = new Set<string>(IMAGE_RADIUS_OPTIONS.map((option) => option.value));

/** 旧配置、导入配置或手改数据都收敛到已知档位；非法值按「跟随主题」处理。 */
export function normalizeImageRadius(value: unknown): ImageRadius {
  return typeof value === 'string' && KNOWN.has(value) ? (value as ImageRadius) : 'theme';
}

/**
 * 明确的圆角像素值；「跟随主题」返回 undefined，交给 CSS 按变体计算。
 * 返回值直接用于内联 style，因此不接受任意用户字符串。
 */
export function imageRadiusCss(value: unknown): string | undefined {
  const preset = normalizeImageRadius(value);
  if (preset === 'theme') return undefined;
  return RADIUS_PX[preset];
}
