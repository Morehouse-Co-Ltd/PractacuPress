import type { LoadingPreset, LoadingSettings, WebConfig } from '../types';
import { settingBool, settingHex, settingInt, settingText } from './settings';

/**
 * 站点加载动画。
 *
 * 预设只决定图形，颜色、背景、尺寸、最短展示时长与附加 CSS 都由站长控制。
 * 加载画面只在前台出现；管理后台、安装向导和页面编排的预览 iframe 不显示，
 * 否则站长每次改一个区块都要等动画走完。
 */

export const DEFAULT_LOADING: LoadingSettings = {
  enabled: false,
  preset: 'spinner',
  text: '正在载入',
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

export const LOADING_PRESETS: { id: LoadingPreset; name: string; note: string }[] = [
  { id: 'spinner', name: '圆环', note: '经典旋转圆环，安静、通用。' },
  { id: 'dots', name: '三点', note: '三个点依次跳动，适合轻快的站点。' },
  { id: 'pulse', name: '呼吸', note: '方块呼吸，配合品牌首字很稳。' },
  { id: 'bar', name: '进度条', note: '一条来回移动的进度线。' },
  { id: 'orbit', name: '轨道', note: '小点绕环旋转，适合杂志与产品站。' },
];

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
