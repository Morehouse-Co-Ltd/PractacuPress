import type {
  SiteCustomization,
  ThemeMode,
  ThemeSettings,
  ThemeSoftenSettings,
  ThemeTokenKey,
} from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 主题基础层：预设、双模式令牌与 CSS 变量输出。
 *
 * 设计约束（来自《「夜航」主题企划书》）：
 * - 深色是主角，浅色是重配而非反色：每个预设都给全两套令牌；
 * - 分层靠线不靠影：令牌里只有 line / line-strong，没有组件级阴影；
 * - 全部走 CSS 变量：主题 CSS 不写组件级硬编码色，切换主题零 JS 开销；
 * - 主色可换、结构不变：夜航与纸白共享同一套区块与数据。
 */

export type ThemeTokenSet = Record<ThemeTokenKey, string>;

export interface ThemePreset {
  id: string;
  name: string;
  note: string;
  /** 预设的主推模式：选中它时会切到这个模式。 */
  mode: ThemeMode;
  light: ThemeTokenSet;
  dark: ThemeTokenSet;
}

/**
 * 深色石墨（夜航 · 默认）。
 *
 * 2026-11 修订：从暖黑 + 薰衣草改为冷石墨 + 电光蓝。底色压得更深，
 * 卡片、输入框和线条靠亮度差分层，不再依赖带紫的暖色；强调色与浅色模式
 * 共用同一支蓝，切换明暗时视觉重心不会跳。
 */
const NIGHT_DARK: ThemeTokenSet = {
  background: '#0b0d11',
  ink: '#f2f4f8',
  accent: '#6e9bff',
  bg_subtle: '#12151b',
  bg_sunken: '#181c24',
  ink_soft: '#c9cfda',
  muted: '#8c93a2',
  faint: '#616978',
  line: '#222832',
  line_strong: '#323a47',
  accent_soft: '#6e9bff1f',
  accent_ink: '#08101f',
  prose: '#cbd1dc',
};

/**
 * 浅色冷白（夜航的浅色重配，不是深色反相）。
 *
 * 这是原来「白昼」卡片设计的延续：近白纸面、白色卡片、电光蓝强调色。
 * 白昼作为独立主题被移除后，它的明亮观感留在这里，由同一个明暗开关切换。
 */
const NIGHT_LIGHT: ThemeTokenSet = {
  background: '#f7f8fa',
  ink: '#101318',
  accent: '#2457f5',
  bg_subtle: '#ffffff',
  bg_sunken: '#eef1f6',
  ink_soft: '#3a404b',
  muted: '#666e7c',
  faint: '#9299a6',
  line: '#e3e7ee',
  line_strong: '#d3d9e3',
  accent_soft: '#eaf0ff',
  accent_ink: '#ffffff',
  prose: '#333944',
};

/**
 * 沉思（浅色）：暖纸白、炭黑与墨蓝。
 *
 * 95% 以上保持中性灰阶，只在链接悬停、阅读进度和极少数核心操作用墨蓝；
 * 深浅模式都使用同一套排印与留白，不靠阴影制造层级。
 */
const CONTEMPLATION_LIGHT: ThemeTokenSet = {
  background: '#faf9f6',
  ink: '#18181b',
  accent: '#2f4a5a',
  bg_subtle: '#f3f1ec',
  bg_sunken: '#eae7e0',
  ink_soft: '#3f3f46',
  muted: '#71717a',
  faint: '#a1a1aa',
  line: '#e4e1da',
  line_strong: '#d3cec4',
  accent_soft: '#e7edef',
  accent_ink: '#faf9f6',
  prose: '#27272a',
};

const CONTEMPLATION_DARK: ThemeTokenSet = {
  background: '#0c0c0e',
  ink: '#e4e4e7',
  accent: '#a9bdc7',
  bg_subtle: '#141416',
  bg_sunken: '#1b1b1e',
  ink_soft: '#c7c7cc',
  muted: '#8e8e93',
  faint: '#636366',
  line: '#26262a',
  line_strong: '#35353a',
  accent_soft: '#a9bdc71f',
  accent_ink: '#0c0c0e',
  prose: '#d4d4d8',
};

/** 白昼：已合并进夜航的冷白重配，旧配置读取时由 customize.ts 折算。 */
const RAW_THEME_PRESETS: ThemePreset[] = [
  {
    id: 'paper',
    name: t('纸白'),
    note: t('白底墨字，克制的绿。原版主题。'),
    mode: 'light',
    light: {
      background: '#ffffff',
      ink: '#14140f',
      accent: '#1f5c4a',
      bg_subtle: '#fafaf7',
      bg_sunken: '#f5f5f0',
      ink_soft: '#4f4f47',
      muted: '#83837a',
      faint: '#a8a89f',
      line: '#e7e7e1',
      line_strong: '#d3d3ca',
      accent_soft: '#eef4f0',
      accent_ink: '#ffffff',
      prose: '#26261f',
    },
    dark: {
      background: '#1a1a18',
      ink: '#f2f1ea',
      accent: '#7fb89f',
      bg_subtle: '#212120',
      bg_sunken: '#262625',
      ink_soft: '#d6d4c8',
      muted: '#a3a096',
      faint: '#75736a',
      line: '#2e2e2a',
      line_strong: '#3d3d38',
      accent_soft: '#7fb89f1f',
      accent_ink: '#10231b',
      prose: '#d6d4c8',
    },
  },
  {
    id: 'sand',
    name: t('暖砂'),
    note: t('米色纸张与赭石强调色，适合长文。'),
    mode: 'light',
    light: {
      background: '#fbf7ee',
      ink: '#2b2418',
      accent: '#9a5b2c',
      bg_subtle: '#f6f1e4',
      bg_sunken: '#efe8d7',
      ink_soft: '#57503f',
      muted: '#8d8270',
      faint: '#b0a692',
      line: '#e8dfcc',
      line_strong: '#d6cbb2',
      accent_soft: '#f4e9dc',
      accent_ink: '#ffffff',
      prose: '#3a3325',
    },
    dark: {
      background: '#211d16',
      ink: '#f5efe2',
      accent: '#d99a5f',
      bg_subtle: '#282419',
      bg_sunken: '#2f2b1f',
      ink_soft: '#ddd3bf',
      muted: '#a89e88',
      faint: '#7d7460',
      line: '#38342a',
      line_strong: '#4a4536',
      accent_soft: '#d99a5f1f',
      accent_ink: '#2a1c0d',
      prose: '#ddd3bf',
    },
  },
  {
    id: 'mist',
    name: t('雾蓝'),
    note: t('偏冷的灰蓝底，安静的技术刊物。'),
    mode: 'light',
    light: {
      background: '#f6f8fa',
      ink: '#182226',
      accent: '#2f5d78',
      bg_subtle: '#eef2f5',
      bg_sunken: '#e5ebef',
      ink_soft: '#43535c',
      muted: '#75838d',
      faint: '#9aa7b0',
      line: '#dde5ea',
      line_strong: '#c6d2da',
      accent_soft: '#e8f0f4',
      accent_ink: '#ffffff',
      prose: '#22323b',
    },
    dark: {
      background: '#151b20',
      ink: '#eef3f7',
      accent: '#6fa8cf',
      bg_subtle: '#1b232a',
      bg_sunken: '#202b33',
      ink_soft: '#cfd9e0',
      muted: '#93a3ad',
      faint: '#6c7c86',
      line: '#27323a',
      line_strong: '#35424c',
      accent_soft: '#6fa8cf1f',
      accent_ink: '#10202b',
      prose: '#cfd9e0',
    },
  },
  {
    id: 'sage',
    name: t('灰绿'),
    note: t('带一点草色的纸面，温和的读感。'),
    mode: 'light',
    light: {
      background: '#f5f7f0',
      ink: '#1d2419',
      accent: '#4d6b3d',
      bg_subtle: '#eef1e7',
      bg_sunken: '#e6ebdc',
      ink_soft: '#46503c',
      muted: '#7d8871',
      faint: '#a3ac97',
      line: '#dfe6d4',
      line_strong: '#c8d2b8',
      accent_soft: '#e9efe1',
      accent_ink: '#ffffff',
      prose: '#27301f',
    },
    dark: {
      background: '#191d17',
      ink: '#f0f4ec',
      accent: '#8db56f',
      bg_subtle: '#1f241d',
      bg_sunken: '#262b23',
      ink_soft: '#d3dcc9',
      muted: '#98a48c',
      faint: '#6f7a64',
      line: '#2a3126',
      line_strong: '#374034',
      accent_soft: '#8db56f1f',
      accent_ink: '#1a2413',
      prose: '#d3dcc9',
    },
  },
  {
    id: 'clay',
    name: t('陶土'),
    note: t('暖红强调色，适合随笔与摄影。'),
    mode: 'light',
    light: {
      background: '#fdf8f5',
      ink: '#2a1e1b',
      accent: '#9b4a3f',
      bg_subtle: '#f8efea',
      bg_sunken: '#f1e3dc',
      ink_soft: '#5c4a44',
      muted: '#94796f',
      faint: '#b89f94',
      line: '#eedfd6',
      line_strong: '#dcc4b8',
      accent_soft: '#f7e7e1',
      accent_ink: '#ffffff',
      prose: '#3a2a25',
    },
    dark: {
      background: '#211815',
      ink: '#f7ece8',
      accent: '#d98873',
      bg_subtle: '#281e1a',
      bg_sunken: '#302521',
      ink_soft: '#e0cdc5',
      muted: '#ab9186',
      faint: '#7f6a61',
      line: '#342823',
      line_strong: '#45352f',
      accent_soft: '#d988731f',
      accent_ink: '#2c1410',
      prose: '#e0cdc5',
    },
  },
  {
    id: 'night',
    name: t('夜航'),
    note: t('冷石墨与电光蓝：深色为主、浅色为同一套设计的明亮重配。'),
    mode: 'dark',
    light: NIGHT_LIGHT,
    dark: NIGHT_DARK,
  },
  {
    id: 'contemplation',
    name: t('沉思'),
    note: t('暖纸白与墨蓝，杂志式留白；深色是同一套版面的低眩光夜读。'),
    mode: 'light',
    light: CONTEMPLATION_LIGHT,
    dark: CONTEMPLATION_DARK,
  },
  {
    id: 'dawn',
    name: t('夜航 · 浅色'),
    note: t('夜航的浅色重配：冷白纸与电光蓝，结构不变。'),
    mode: 'light',
    light: NIGHT_LIGHT,
    dark: NIGHT_DARK,
  },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const THEME_PRESETS = liveCatalog(RAW_THEME_PRESETS);

const RAW_THEME_TOKENS: { key: ThemeTokenKey; label: string; hint: string; advanced: boolean }[] = [
  { key: 'background', label: t('页面底色'), hint: t('全站背景。'), advanced: false },
  { key: 'ink', label: t('主文字'), hint: t('标题与强调文字。'), advanced: false },
  { key: 'accent', label: t('强调色'), hint: t('链接、当前状态与焦点环。'), advanced: false },
  { key: 'bg_subtle', label: t('卡片底'), hint: t('卡片与浮层，深色下必须能与底色区分。'), advanced: true },
  { key: 'bg_sunken', label: t('下沉底'), hint: t('输入框、代码块与次级块。'), advanced: true },
  { key: 'ink_soft', label: t('正文色'), hint: t('文章正文使用。'), advanced: true },
  { key: 'muted', label: t('次要文字'), hint: t('说明与 meta 信息。'), advanced: true },
  { key: 'faint', label: t('弱化文字'), hint: t('时间、计数等非关键信息。'), advanced: true },
  { key: 'line', label: t('分隔线'), hint: t('区块之间的细线。'), advanced: true },
  { key: 'line_strong', label: t('卡片描边'), hint: t('深色下的分层手段，1px。'), advanced: true },
  { key: 'accent_soft', label: t('强调浅底'), hint: t('强调色的低透明度底色。'), advanced: true },
  { key: 'accent_ink', label: t('强调色上的文字'), hint: t('主色按钮与胶囊的文字色。'), advanced: true },
  { key: 'prose', label: t('阅读正文'), hint: t('文章页正文颜色，对比度要求最高。'), advanced: true },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const THEME_TOKENS = liveCatalog(RAW_THEME_TOKENS);

export const DEFAULT_SOFTEN: ThemeSoftenSettings = {
  enabled: false,
  strength: 45,
  transition_ms: 240,
  gradient: true,
  blend_components: true,
  blur: 8,
};

export const DEFAULT_THEME: ThemeSettings = {
  preset: 'paper',
  mode: 'light',
  background: '#ffffff',
  ink: '#14140f',
  accent: '#1f5c4a',
  heading_font: 'serif',
  body_size: 17.5,
  content_width: 880,
  radius: 6,
  soften: DEFAULT_SOFTEN,
};

const THEME_TOKEN_KEYS = new Set<string>([
  'background',
  'ink',
  'accent',
  'bg_subtle',
  'bg_sunken',
  'ink_soft',
  'muted',
  'faint',
  'line',
  'line_strong',
  'accent_soft',
  'accent_ink',
  'prose',
]);

function themeText(value: unknown, fallback: string, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function themeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function themeHalfNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 2) / 2));
}

/** 令牌值长度上限：够放下 color-mix 表达式，又不至于塞进一整段样式表。 */
const CSS_VALUE_MAX = 120;

/** 十六进制颜色只收 3/4/6/8 位：#abc / #abcd / #aabbcc / #aabbccdd。 */
const CSS_HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 允许的函数式颜色：只收这几个名字，`url(` / `expression(` 之类都进不来。 */
const CSS_COLOR_FUNCTION = /^(?:color-mix|rgba?|hsla?)\(/i;

/** 裸变量引用：`var(--name)`，不收带兜底值的嵌套写法。 */
const CSS_VAR_REFERENCE = /^var\(--[A-Za-z0-9_-]+\)$/;

/** 函数式颜色允许出现的字符；`;`、`{}`、引号、反斜杠、`@` 都不在其中。 */
const CSS_VALUE_CHARS = /^[A-Za-z0-9#%().,\s/+-]+$/;

function themeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && CSS_HEX_COLOR.test(value.trim())
    ? value.trim()
    : fallback;
}

/**
 * 主题令牌的严格校验：整串匹配，只放行十六进制颜色、允许的函数式颜色与裸 var()。
 *
 * 令牌最终会被拼进 `:root { --token: VALUE; }`，因此值里只要出现 `;` 或 `}`
 * 就能提前闭合声明块并注入任意全局 CSS。这里只做「整串形状」判断，不做子串修补：
 * 任何不认识的值都返回 undefined，由调用方丢弃。
 */
export function safeCssValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CSS_VALUE_MAX) return undefined;
  if (CSS_HEX_COLOR.test(trimmed)) return trimmed;
  if (CSS_VAR_REFERENCE.test(trimmed)) return trimmed;
  if (!CSS_COLOR_FUNCTION.test(trimmed)) return undefined;
  if (!trimmed.endsWith(')')) return undefined;
  if (!CSS_VALUE_CHARS.test(trimmed)) return undefined;
  // 字符集已经排除了 `;{}<>"'\\@`，这里再挡掉三种「合法字符组成的逃逸」。
  const lower = trimmed.toLowerCase();
  if (lower.includes('url(') || lower.includes('!important') || lower.includes('/*')) {
    return undefined;
  }
  // 括号必须配平，且不能出现反向的 `)`。
  let depth = 0;
  for (const char of trimmed) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth < 0) return undefined;
  }
  return depth === 0 ? trimmed : undefined;
}

/** 主题令牌的白名单与格式校验；导入主题与旧配置共用。 */
export function normalizeThemeTokens(value: unknown): ThemeSettings['tokens'] {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!THEME_TOKEN_KEYS.has(key)) continue;
    const safe = safeCssValue(item);
    if (safe) out[key] = safe;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 把任意来源（旧配置、导入主题、手工编辑）收敛成完整主题。 */
export function normalizeThemeSettings(value: unknown): ThemeSettings {
  const raw = (value ?? {}) as Partial<ThemeSettings>;
  const rawSoften = (raw.soften ?? {}) as Partial<ThemeSoftenSettings>;
  return {
    preset: themeText(raw.preset, DEFAULT_THEME.preset, 40),
    mode: raw.mode === 'dark' ? 'dark' : 'light',
    background: themeColor(raw.background, DEFAULT_THEME.background),
    ink: themeColor(raw.ink, DEFAULT_THEME.ink),
    accent: themeColor(raw.accent, DEFAULT_THEME.accent),
    tokens: normalizeThemeTokens(raw.tokens),
    heading_font: raw.heading_font === 'sans' ? 'sans' : 'serif',
    body_size: themeHalfNumber(raw.body_size, DEFAULT_THEME.body_size, 14, 20),
    content_width: themeNumber(raw.content_width, DEFAULT_THEME.content_width, 840, 1120),
    radius: themeNumber(raw.radius, DEFAULT_THEME.radius, 0, 12),
    soften: {
      enabled: rawSoften.enabled === true,
      strength: themeNumber(rawSoften.strength, DEFAULT_SOFTEN.strength, 0, 100),
      transition_ms: themeNumber(rawSoften.transition_ms, DEFAULT_SOFTEN.transition_ms, 0, 1200),
      gradient: rawSoften.gradient !== false,
      blend_components: rawSoften.blend_components !== false,
      blur: themeNumber(rawSoften.blur, DEFAULT_SOFTEN.blur, 0, 24),
    },
  };
}

export function presetById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((item) => item.id === id);
}

/** 取某个预设在指定模式下的完整令牌；未知预设返回 null。 */
export function presetTokens(id: string, mode: ThemeMode): ThemeTokenSet | null {
  const preset = presetById(id);
  if (!preset) return null;
  return { ...preset[mode] };
}

/** 自定义配色（preset = custom）时，由三基色推导其余令牌。 */
function deriveFromBase(theme: ThemeSettings): ThemeTokenSet {
  const { background: bg, ink, accent } = theme;
  return {
    background: bg,
    ink,
    accent,
    bg_subtle: `color-mix(in srgb, var(--bg) 96%, var(--ink))`,
    bg_sunken: `color-mix(in srgb, var(--bg) 92%, var(--ink))`,
    ink_soft: `color-mix(in srgb, var(--ink) 78%, var(--bg))`,
    muted: `color-mix(in srgb, var(--ink) 58%, var(--bg))`,
    faint: `color-mix(in srgb, var(--ink) 42%, var(--bg))`,
    line: `color-mix(in srgb, var(--ink) 10%, var(--bg))`,
    line_strong: `color-mix(in srgb, var(--ink) 18%, var(--bg))`,
    accent_soft: `color-mix(in srgb, var(--accent) 9%, var(--bg))`,
    accent_ink: `color-mix(in srgb, var(--accent) 22%, #000000)`,
    prose: `color-mix(in srgb, var(--ink) 88%, var(--bg))`,
  };
}

/** 解析出最终生效的令牌：预设底 → 自定义推导 → 高级覆盖。 */
export function resolveTokens(theme: ThemeSettings, mode: ThemeMode = theme.mode): ThemeTokenSet {
  const fromPreset = presetTokens(theme.preset, mode);
  const base = fromPreset ?? deriveFromBase(theme);
  const overrides = theme.tokens ?? {};
  const next: ThemeTokenSet = { ...base };
  for (const key of Object.keys(overrides) as ThemeTokenKey[]) {
    // 覆盖值可能来自导入文件或旧配置，没走 normalizeThemeTokens 也要挡一次。
    const safe = safeCssValue(overrides[key]);
    if (safe) next[key] = safe;
  }
  return next;
}

function relativeLuminance(hex: string): number | null {
  const value = hex.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const raw = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const channels = [0, 2, 4].map((offset) => {
    const channel = parseInt(raw.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * 在给定底色上挑一个能读的文字色。
 *
 * 安装向导的主题预览会把主题自己的底色与文字色画进一张小卡片：主题作者
 * 如果填了一对低对比度的值，预览里的「Aa」就会消失。这里只用十六进制值
 * 计算相对亮度，对比不足时退回黑或白，保证预览始终可读；不是十六进制
 * （例如 color-mix 表达式）时原样返回，让 CSS 自己处理。
 */
export function readableInk(background: string, preferred: string): string {
  const bg = relativeLuminance(background);
  const ink = relativeLuminance(preferred);
  if (bg === null) return preferred;
  if (ink !== null) {
    const lighter = Math.max(bg, ink);
    const darker = Math.min(bg, ink);
    if ((lighter + 0.05) / (darker + 0.05) >= 3) return preferred;
  }
  return bg > 0.45 ? '#101318' : '#f7f8fa';
}

/**
 * 数据令牌名 → CSS 变量名。
 * `background` 是唯一的不规则项：全站样式消费 `--bg`（styles.css 的 :root 基准），
 * 而数据模型沿用语义化的 `background`。新增令牌时保持这里的映射同步。
 */
const CSS_TOKEN_NAME: Record<string, string> = {
  background: '--bg',
};

/** 生成站点主题的 CSS 变量。派生色由 color-mix 计算，保证同一套配色自洽。 */
export function themeCss(customization: SiteCustomization, mode?: ThemeMode): string {
  const { theme } = customization;
  const tokens = resolveTokens(theme, mode ?? theme.mode);
  const r = theme.radius;
  const sm = Math.max(0, r - 2);
  const lg = Math.min(16, r + 4);
  // 拼进 `:root { }` 之前再过一遍校验：上游漏掉任何一层，也不会让值提前闭合声明块。
  const lines = Object.entries(tokens)
    .map(([key, value]) => {
      const safe = safeCssValue(value);
      return safe ? `  ${CSS_TOKEN_NAME[key] ?? `--${key.replace(/_/g, '-')}`}: ${safe};` : null;
    })
    .filter((line): line is string => line !== null);
  // 后台有自己的明暗模式：浅色沿用纸白令牌（与改造前完全一致），深色用夜航的
  // 冷石墨令牌。两者都写在 html[data-surface="admin"] 下，站点前台的 :root 不受影响。
  //
  // 同一组令牌还挂在后台根节点 `.admin-shell` 上：`data-surface` 是运行时属性，
  // 站点外壳 / 安装向导卸载时会在被动 effect 里删掉或改回 site，后台就会掉回站点
  // 主题的令牌。深色站点上那就是白面板配浅色字、搜索框与空状态整块变黑。令牌钉在
  // 后台子树上以后，属性丢了也只是少一层隔离，配色不会串。
  const adminTokens = presetTokens('paper', 'light')!;
  const adminLines = Object.entries(adminTokens).map(
    ([key, value]) => `  ${CSS_TOKEN_NAME[key] ?? `--${key.replace(/_/g, '-')}`}: ${value};`,
  );
  const adminDarkTokens = presetTokens('night', 'dark')!;
  const adminDarkLines = Object.entries(adminDarkTokens).map(
    ([key, value]) => `  ${CSS_TOKEN_NAME[key] ?? `--${key.replace(/_/g, '-')}`}: ${value};`,
  );
  return `:root {
${lines.join('\n')}
  --article-width: ${theme.content_width}px;
  --article-size: ${theme.body_size}px;
  --soften-strength: ${theme.soften.enabled ? theme.soften.strength : 0};
  --soften-ms: ${theme.soften.enabled ? theme.soften.transition_ms : 0}ms;
  --soften-blur: ${theme.soften.enabled ? theme.soften.blur : 0}px;
  --r-sm: ${sm}px;
  --r-md: ${r}px;
  --r-lg: ${lg}px;
  --r-pill: 999px;
  --shadow-hero: 0 24px 60px -30px rgb(0 0 0 / .65);
  --shell: min(100%, 1760px);${theme.heading_font === 'sans' ? '\n  --serif: var(--sans);' : ''}
}
html[data-surface="admin"],
.admin-shell {
  color-scheme: light;
${adminLines.join('\n')}
  --admin-panel: #ffffff;
  --admin-panel-alt: #fafaf7;
  --admin-border: #ecece6;
  --admin-border-soft: #e7e8e0;
  --admin-hover: #f2f3ee;
  --admin-glass: rgba(255, 255, 255, 0.9);
  --admin-glass-strong: rgba(255, 255, 255, 0.94);
  --admin-glow: #f5f6f1;
  --article-width: 720px;
  --article-size: 17.5px;
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 10px;
}
/* 后台根节点自己也要带上前景色：属性丢失时 body 的 color 来自站点主题，
   子元素会继承那份解析结果，而不是重新按后台令牌求值。 */
.admin-shell { color: var(--ink); }
/* 后台深色：与站点前台的主题完全解耦，只由后台自己的偏好（data-admin-theme）触发。 */
html[data-surface="admin"][data-admin-theme="dark"],
html[data-admin-theme="dark"] .admin-shell {
  color-scheme: dark;
${adminDarkLines.join('\n')}
  --admin-panel: #12151b;
  --admin-panel-alt: #181c24;
  --admin-border: #222832;
  --admin-border-soft: #2a313c;
  --admin-hover: #1d2430;
  --admin-glass: rgba(18, 21, 27, 0.9);
  --admin-glass-strong: rgba(18, 21, 27, 0.94);
  --admin-glow: #0f141d;
  --article-width: 720px;
  --article-size: 17.5px;
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 10px;
}
/* 安装向导：固定浅色纸面令牌。
   安装时浏览器里可能还留着上一次安装的深色主题变量，而向导里的语言切换、选项卡
   和检查项有硬编码的白底；不隔离的话会出现白底上的浅色字。 */
html[data-surface="setup"] {
  color-scheme: light;
${adminLines.join('\n')}
  --article-width: 720px;
  --article-size: 17.5px;
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 16px;
}
/* 站点前台深色：错误 / 警告 / 成功这组语义色不在主题令牌里，styles.css 的基准
   是浅色纸面。深色主题下沿用浅色值会出现「浅粉底 + 浅色字」——后端连不上时
   首页与列表页的离线提示就是一块看不见的方块，表单错误也读不清。
   这里换成亮色语义色 + 由当前底色混出的浅底，与后台深色的处理保持一致。 */
html[data-surface="site"][data-mode="dark"] {
  --danger: #f08a76;
  --warn: #e0bd6b;
  --ok: #74c69d;
  --danger-soft: color-mix(in srgb, var(--danger) 16%, var(--bg));
  --warn-soft: color-mix(in srgb, var(--warn) 16%, var(--bg));
  --ok-soft: color-mix(in srgb, var(--ok) 16%, var(--bg));
}
/* 后台与安装向导：body 底色跟随各自的令牌。后台深色由 data-admin-theme 切换；
   安装向导始终固定浅色。index.html 里的「深色模式首屏防闪」规则优先级相同，
   所以要用同一层的规则把底色与文字拉回当前界面自己的令牌。 */
html[data-surface="admin"] body,
html[data-surface="setup"] body {
  background: var(--bg);
  color: var(--ink);
}
/* 柔化：背景光晕 + 组件颜色平滑过渡；只在站点前台生效，后台保持清晰。 */
html[data-surface="site"] body {
  transition: background-color var(--soften-ms) ease, color var(--soften-ms) ease;
}
html[data-surface="site"][data-soften="on"] body::before {
  content: "";
  position: fixed;
  inset: -12%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(55% 50% at 12% 0%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 72%),
    radial-gradient(48% 44% at 92% 12%, color-mix(in srgb, var(--ink) 16%, transparent), transparent 68%);
  opacity: calc(var(--soften-strength) / 220);
  transition: opacity var(--soften-ms) ease;
}
html[data-surface="site"][data-soften="on"] .site { position: relative; z-index: 1; }
html[data-surface="site"][data-soften="on"] .site-header {
  backdrop-filter: blur(calc(8px + var(--soften-blur)));
}
html[data-surface="site"][data-soften="on"] .site-header,
html[data-surface="site"][data-soften="on"] .site-subnav,
html[data-surface="site"][data-soften="on"] .site-footer,
html[data-surface="site"][data-soften="on"] .article-card,
html[data-surface="site"][data-soften="on"] .home-card,
html[data-surface="site"][data-soften="on"] .menu-pop,
html[data-surface="site"][data-soften="on"] .announce,
html[data-surface="site"][data-soften="on"] .btn,
html[data-surface="site"][data-soften="on"] .chip {
  transition:
    background-color var(--soften-ms) ease,
    border-color var(--soften-ms) ease,
    color var(--soften-ms) ease,
    box-shadow var(--soften-ms) ease;
}
html[data-surface="site"][data-soften-blend="on"] .site-header {
  background-color: color-mix(in srgb, var(--bg) 90%, var(--accent) 10%);
}
html[data-surface="site"][data-soften-blend="on"] .site-subnav,
html[data-surface="site"][data-soften-blend="on"] .site-footer {
  background-color: color-mix(in srgb, var(--bg-subtle) 90%, var(--accent) 10%);
}
html[data-surface="site"][data-soften-blend="on"] .article-card,
html[data-surface="site"][data-soften-blend="on"] .home-card,
html[data-surface="site"][data-soften-blend="on"] .menu-pop {
  background-color: color-mix(in srgb, var(--bg-subtle) 88%, var(--accent) 12%);
}
html[data-surface="site"][data-soften-gradient="on"] .site-footer {
  background-image: linear-gradient(180deg, transparent, color-mix(in srgb, var(--accent) 7%, transparent));
}
@media (prefers-reduced-motion: reduce) {
  html[data-surface="site"] body,
  html[data-surface="site"][data-soften="on"] * {
    transition-duration: 0ms !important;
  }
}`;
}

/** 选中预设：同时切到它的主推模式，并清掉高级覆盖（覆盖是分模式的）。 */
export function applyPreset(theme: ThemeSettings, presetId: string): ThemeSettings {
  const preset = presetById(presetId);
  if (!preset) return theme;
  const tokens = presetTokens(presetId, preset.mode)!;
  return {
    ...theme,
    preset: preset.id,
    mode: preset.mode,
    background: tokens.background,
    ink: tokens.ink,
    accent: tokens.accent,
    tokens: undefined,
  };
}

/**
 * 切换明暗模式。已知预设会整组换令牌；自定义配色保持当前值
 * （自定义色对两个模式都生效，避免浅色下出现刺眼的纯白）。
 */
export function applyMode(theme: ThemeSettings, mode: ThemeMode): ThemeSettings {
  if (theme.mode === mode) return theme;
  const preset = presetById(theme.preset);
  if (preset) {
    const tokens = presetTokens(theme.preset, mode)!;
    return {
      ...theme,
      mode,
      background: tokens.background,
      ink: tokens.ink,
      accent: tokens.accent,
      tokens: undefined,
    };
  }
  return { ...theme, mode };
}

/** 把模式写到 <html data-mode>，供 CSS 与组件读取。 */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.mode = mode;
}

/** 把柔化开关写到 <html>，CSS 只在站点前台读取这些属性。 */
export function applySoftenAttributes(theme: ThemeSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const soften = theme.soften ?? DEFAULT_SOFTEN;
  root.dataset.soften = soften.enabled ? 'on' : 'off';
  root.dataset.softenGradient = soften.enabled && soften.gradient ? 'on' : 'off';
  root.dataset.softenBlend = soften.enabled && soften.blend_components ? 'on' : 'off';
}
