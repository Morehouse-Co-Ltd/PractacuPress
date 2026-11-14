import { describe, expect, it } from 'vitest';
import {
  normalizeThemeSettingValues,
  normalizeThemeSettingsSchema,
  themeHasSettings,
} from './themeSettings';
import type { SiteTheme } from '../types';
import { DEFAULT_THEME } from './theme';

const schema = {
  version: 1,
  tabs: [
    {
      id: 'home',
      label: '首页',
      fields: [
        { key: 'eyebrow', label: '眉题', type: 'text', default: 'AURORA', maxLength: 40 },
        { key: 'show_tags', label: '显示标签', type: 'toggle', default: true },
        {
          key: 'align',
          label: '对齐',
          type: 'select',
          default: 'left',
          options: [{ value: 'left', label: '左' }],
        },
      ],
    },
  ],
};

describe('主题自定义设置协议', () => {
  it('解析合法字段并保留默认值', () => {
    const parsed = normalizeThemeSettingsSchema(schema)!;
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs[0].fields.map((field) => field.key)).toEqual([
      'eyebrow',
      'show_tags',
      'align',
    ]);
    expect(parsed.tabs[0].fields[0].default).toBe('AURORA');
    expect(parsed.tabs[0].fields[1].type).toBe('toggle');
    expect(parsed.tabs[0].fields[2].options).toEqual([{ value: 'left', label: '左' }]);
  });

  it('拒绝没有字段的 tab、未知字段类型与非法 id', () => {
    expect(normalizeThemeSettingsSchema({ tabs: [] })).toBeNull();
    expect(
      normalizeThemeSettingsSchema({
        tabs: [{ id: 'x', label: 'X', fields: [{ key: 'a', label: 'A', type: 'unknown' }] }],
      }),
    ).toBeNull();
    expect(
      normalizeThemeSettingsSchema({
        tabs: [{ id: 'Bad ID', label: 'X', fields: [{ key: 'a', label: 'A', type: 'text' }] }],
      }),
    ).toBeNull();
  });

  it('replace_default 可由清单或数据文件声明', () => {
    expect(normalizeThemeSettingsSchema(schema)!.replace_default).toBe(false);
    expect(normalizeThemeSettingsSchema(schema, true)!.replace_default).toBe(true);
    expect(normalizeThemeSettingsSchema({ ...schema, replace_default: true })!.replace_default).toBe(
      true,
    );
  });

  it('settings 只接受三层 map 与标量值', () => {
    expect(normalizeThemeSettingValues(undefined)).toBeUndefined();
    expect(normalizeThemeSettingValues('nope')).toBeUndefined();
    expect(
      normalizeThemeSettingValues({
        theme_1: {
          home: { eyebrow: 'hi', show: true, count: 3, bad: { nested: 1 }, list: [1] },
        },
        'Bad Theme': { home: { a: 'x' } },
      }),
    ).toEqual({ theme_1: { home: { eyebrow: 'hi', show: true, count: 3 } } });
  });

  it('只有声明了 tabs 的主题才算自带设置', () => {
    const theme: SiteTheme = {
      id: 'x',
      name: 'X',
      note: '',
      variant: 'classic',
      theme: DEFAULT_THEME,
    };
    expect(themeHasSettings(theme)).toBe(false);
    expect(themeHasSettings({ ...theme, settings: normalizeThemeSettingsSchema(schema)! })).toBe(
      true,
    );
  });
});
