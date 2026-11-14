import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  normalizeThemeSettings,
  normalizeThemeTokens,
  resolveTokens,
  safeCssValue,
  themeCss,
} from './theme';

/** 令牌最终会被拼进 `:root { --token: VALUE; }`，所以这里只测这一层的输出。 */
function cssFor(tokens: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return themeCss({ theme: { ...DEFAULT_THEME, ...extra, tokens } } as never);
}

/** 截出 `:root { ... }` 这一段，用来确认没有值提前闭合声明块。 */
function rootBlock(css: string): string {
  return css.slice(css.indexOf(':root {'), css.indexOf('html[data-surface="admin"]'));
}

const INJECTION_PAYLOADS = [
  'var(--x); } body { display:none } :root { --y: red',
  '#fff; } * { display: none }',
  'color-mix(in srgb, red 50%, blue);}html{display:none}',
  'var(--x) }',
];

describe('theme token value allowlist', () => {
  const accepted = [
    '#fff',
    '#ffff',
    '#ffffff',
    '#ffffffff',
    'var(--bg)',
    'var(--accent_soft)',
    'var(--accent-soft)',
    'color-mix(in srgb, var(--bg) 96%, var(--ink))',
    'rgb(0 0 0 / .65)',
    'rgba(0, 0, 0, 0.5)',
    'hsl(220 40% 20%)',
    'hsla(220, 40%, 20%, .4)',
  ];

  for (const value of accepted) {
    it(`accepts ${value}`, () => {
      expect(safeCssValue(value)).toBe(value);
    });
  }

  const rejected: [string, string][] = [
    ['带兜底值的 var()', 'var(--bg, #fff)'],
    ['提前闭合声明块', 'var(--x); } body { display:none } :root { --y: red'],
    ['十六进制后接声明', '#fff; } * { display: none }'],
    ['函数后接声明', 'color-mix(in srgb, red 50%, blue);}html{display:none}'],
    ['多余右括号', 'color-mix(in srgb, red 50%, blue))'],
    ['!important', 'rgb(0 0 0) !important'],
    ['url()', 'url(https://evil.example/x.png)'],
    ['注释逃逸', 'color-mix(in srgb, red 50%, blue) /* x */'],
    ['括号未配平', 'color-mix(in srgb, red 50%, blue'],
    ['反向括号', 'rgb(0 0 0))'],
    ['未知函数', 'expression(alert(1))'],
    ['位数不对的十六进制', '#fffff'],
    ['命名颜色', 'red'],
    ['对象字面量', '{"x":1}'],
    ['首尾引号', 'color-mix(in srgb, "red" 50%, blue)'],
    ['超长值', `color-mix(in srgb, ${'#fff '.repeat(30)}red)`],
    ['空字符串', '   '],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(safeCssValue(value)).toBeUndefined();
    });
  }

  it('rejects non-string values', () => {
    expect(safeCssValue(42)).toBeUndefined();
    expect(safeCssValue(null)).toBeUndefined();
    expect(safeCssValue(['#fff'])).toBeUndefined();
  });
});

describe('theme token normalization', () => {
  it('keeps valid overrides and drops everything else', () => {
    const normalized = normalizeThemeTokens({
      background: 'color-mix(in srgb, var(--bg) 96%, var(--ink))',
      ink: '#fff',
      accent: 'var(--x)',
      line: 'rgb(0 0 0 / .2)',
      muted: 'var(--x); } body { display:none } :root { --y: red',
      faint: '#fff; } * { display: none }',
      prose: 42,
      unknown_key: '#fff',
    });

    expect(normalized).toEqual({
      background: 'color-mix(in srgb, var(--bg) 96%, var(--ink))',
      ink: '#fff',
      accent: 'var(--x)',
      line: 'rgb(0 0 0 / .2)',
    });
  });

  it('returns undefined when nothing survives the allowlist', () => {
    expect(normalizeThemeTokens({ accent: '#fff; } * { display: none }' })).toBeUndefined();
    expect(normalizeThemeSettings({ ...DEFAULT_THEME, tokens: { ink: 'var(--x) }' } }).tokens).toBeUndefined();
  });

  it('resolveTokens drops overrides that skipped normalization', () => {
    const resolved = resolveTokens({
      ...DEFAULT_THEME,
      tokens: { background: 'var(--x); } body { display:none } :root { --y: red' },
    });

    expect(resolved.background).toBe('#ffffff');
  });
});

describe('article column width', () => {
  it('defaults wider and clamps older 720px customizations up to the new minimum', () => {
    expect(DEFAULT_THEME.content_width).toBe(880);
    // 旧配置里的 720 落在新范围之外，归一化后会被抬到 840（预期行为）。
    expect(normalizeThemeSettings({ ...DEFAULT_THEME, content_width: 720 }).content_width).toBe(840);
    expect(normalizeThemeSettings({ ...DEFAULT_THEME, content_width: 960 }).content_width).toBe(960);
    expect(normalizeThemeSettings({ ...DEFAULT_THEME, content_width: 2000 }).content_width).toBe(1120);
  });
});

describe('themeCss keeps injected tokens inside :root', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`does not emit ${payload.slice(0, 24)}…`, () => {
      const css = cssFor({ background: payload, ink: payload, accent: payload });
      const block = rootBlock(css);

      // :root 里只应出现一对大括号：值没有提前闭合声明块。
      expect((block.match(/\{/g) ?? []).length).toBe(1);
      expect((block.match(/\}/g) ?? []).length).toBe(1);
      expect(css).not.toContain(payload);
      expect(css.toLowerCase()).not.toContain('display:none');
      expect(css.toLowerCase()).not.toContain('display: none');
      // 模板自带的 prefers-reduced-motion 里有且只有一处 !important。
      expect((css.match(/!important/g) ?? []).length).toBe(1);
    });
  }

  it('still emits a valid color-mix override', () => {
    const css = cssFor({ accent: 'color-mix(in srgb, var(--bg) 96%, var(--ink))' });

    expect(css).toContain('--accent: color-mix(in srgb, var(--bg) 96%, var(--ink));');
  });

  it('still emits the derived color-mix tokens for custom presets', () => {
    const css = cssFor({}, { preset: 'custom' });

    expect(css).toContain('--bg-subtle: color-mix(in srgb, var(--bg) 96%, var(--ink));');
    expect(css).toContain('--bg: #ffffff;');
  });

  it('keeps the preset hex tokens when overrides are invalid', () => {
    const css = cssFor({ background: '#fff; } * { display: none }' });

    expect(css).toContain('--bg: #ffffff;');
    expect((rootBlock(css).match(/\}/g) ?? []).length).toBe(1);
  });
});
