import type { LoadingPreset, LoadingSettings, WebConfig } from '../types';
import { t } from './i18n';
import { settingBool, settingHex, settingInt, settingText } from './settings';
import { liveCatalog } from './i18n/live';

/**
 * 站点加载动画。
 *
 * 预设决定两件事：全屏图形，或者页面内的原位骨架。颜色、背景、尺寸、最短展示
 * 时长与附加 CSS 都由站长控制。加载画面只在前台出现；管理后台、安装向导和页面
 * 编排的预览 iframe 不显示，否则站长每次改一个区块都要等动画走完。
 */

export const DEFAULT_LOADING: LoadingSettings = {
  enabled: false,
  preset: 'spinner',
  text: t('正在载入'),
  accent_mode: 'theme',
  accent: '#1f5c4a',
  background_mode: 'theme',
  background: '#ffffff',
  size: 44,
  min_duration_ms: 450,
  show_on_first_load: true,
  show_on_navigation: false,
  custom_css: '',
};

const RAW_LOADING_PRESETS: { id: LoadingPreset; name: string; note: string }[] = [
  { id: 'spinner', name: t('圆环'), note: t('经典旋转圆环，安静、通用。') },
  { id: 'dots', name: t('三点'), note: t('三个点依次跳动，适合轻快的站点。') },
  { id: 'pulse', name: t('呼吸'), note: t('方块呼吸，配合品牌首字很稳。') },
  { id: 'bar', name: t('进度条'), note: t('一条来回移动的进度线。') },
  { id: 'orbit', name: t('轨道'), note: t('小点绕环旋转，适合杂志与产品站。') },
  { id: 'skeleton', name: t('骨架'), note: t('内容区先显示与最终版式同位置的骨架占位。') },
  { id: 'shimmer', name: t('扫光'), note: t('骨架占位上叠一条横向扫光，加载反馈更明显。') },
  {
    id: 'skeleton-shimmer',
    name: t('骨架 + 扫光'),
    note: t('骨架呼吸与扫光同时进行，是推荐的配合方式。'),
  },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const LOADING_PRESETS = liveCatalog(RAW_LOADING_PRESETS);

/** 原位骨架：不盖全屏遮罩，按内容最终出现的位置画占位。 */
export const SKELETON_PRESETS: readonly LoadingPreset[] = [
  'skeleton',
  'shimmer',
  'skeleton-shimmer',
];

const SKELETON_SET = new Set<LoadingPreset>(SKELETON_PRESETS);

export type SkeletonMotion = 'pulse' | 'sweep' | 'both';

export function isSkeletonPreset(preset: LoadingPreset): boolean {
  return SKELETON_SET.has(preset);
}

/**
 * 加载方式三选一：
 * - off：关闭，或全屏预设但两个显示场景都关了；
 * - overlay：现有全屏遮罩；
 * - skeleton：原位骨架，由页面自己的 loading 状态驱动，不看显示场景开关。
 */
export function loadingApproach(settings: LoadingSettings): 'off' | 'overlay' | 'skeleton' {
  if (!settings.enabled) return 'off';
  if (isSkeletonPreset(settings.preset)) return 'skeleton';
  return settings.show_on_first_load || settings.show_on_navigation ? 'overlay' : 'off';
}

/** 骨架动效；非骨架预设返回 null。是否启用由 `loadingApproach` 判断。 */
export function skeletonMotion(settings: LoadingSettings): SkeletonMotion | null {
  switch (settings.preset) {
    case 'skeleton':
      return 'pulse';
    case 'shimmer':
      return 'sweep';
    case 'skeleton-shimmer':
      return 'both';
    default:
      return null;
  }
}


const PRESETS = new Set<LoadingPreset>(LOADING_PRESETS.map((item) => item.id));

export function readLoading(config: Pick<WebConfig, 'loading'>): LoadingSettings {
  const raw = config.loading;
  const preset = typeof raw?.preset === 'string' && PRESETS.has(raw.preset as LoadingPreset)
    ? (raw.preset as LoadingPreset)
    : DEFAULT_LOADING.preset;
  return {
    enabled: settingBool(raw?.enabled, DEFAULT_LOADING.enabled),
    preset,
    text: settingText(raw?.text, DEFAULT_LOADING.text, 80),
    accent_mode: raw?.accent_mode === 'custom' ? 'custom' : 'theme',
    accent: settingHex(raw?.accent, DEFAULT_LOADING.accent),
    background_mode: raw?.background_mode === 'custom' ? 'custom' : 'theme',
    background: settingHex(raw?.background, DEFAULT_LOADING.background),
    size: settingInt(raw?.size, DEFAULT_LOADING.size, 16, 160),
    min_duration_ms: settingInt(raw?.min_duration_ms, DEFAULT_LOADING.min_duration_ms, 0, 3000),
    show_on_first_load: settingBool(raw?.show_on_first_load, DEFAULT_LOADING.show_on_first_load),
    show_on_navigation: settingBool(
      raw?.show_on_navigation,
      DEFAULT_LOADING.show_on_navigation,
    ),
    custom_css: settingText(raw?.custom_css, '', 4000),
  };
}

export interface LoadingPalette {
  background: string;
  ink: string;
  accent: string;
}

/** 预览时用主题的实际令牌模拟前台，而不是后台固定的纸白令牌。 */
export function loadingPalette(settings: LoadingSettings, theme: LoadingPalette): LoadingPalette {
  return {
    background: settings.background_mode === 'custom' ? settings.background : theme.background,
    ink: theme.ink,
    accent: settings.accent_mode === 'custom' ? settings.accent : theme.accent,
  };
}

/** 只有明确启用的加载画面才需要渲染。 */
export function loadingEnabled(settings: LoadingSettings): boolean {
  return (
    settings.enabled &&
    (settings.show_on_first_load || settings.show_on_navigation)
  );
}

export type SkeletonShape =
  | 'feed'
  | 'list'
  | 'grid'
  | 'feature'
  | 'mosaic'
  | 'aside';

/**
 * 页面编排里会等内容的区块 → 骨架形状。
 *
 * 只登记真正依赖 FeedContext 的区块：静态区块（标题、文本、按钮、图片等）
 * 立刻就能画出真实内容，不该被骨架盖住。未登记的类型由渲染器自己处理，
 * 这样新组件不会因为漏登记而白屏。
 */
export const BLOCK_SKELETON_SHAPES: Record<string, SkeletonShape> = {
  feed: 'feed',
  'post-list': 'list',
  'post-grid': 'grid',
  'feature-post': 'feature',
  spotlight: 'mosaic',
  'spotlight-hot': 'mosaic',
  'stat-list': 'aside',
  archive: 'aside',
  articles: 'grid',
  'popular-content': 'list',
  'recent-content': 'list',
  // P3 查询块：真实后端自己取数，演示模式读 FeedContext，两种模式都可能等 feed，
  // 形状取与「文章组件」相同的卡片网格（列表布局也落在同一套卡片样式上）。
  'content-query': 'grid',
};
