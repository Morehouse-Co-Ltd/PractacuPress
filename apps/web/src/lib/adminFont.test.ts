import { describe, expect, it } from 'vitest';
import {
  ADMIN_FONT_SCALE_MAX,
  ADMIN_FONT_SCALE_MIN,
  DEFAULT_ADMIN_FONT_SCALE,
  adminFontPercent,
  normalizeAdminFontScale,
} from './adminFont';

describe('管理后台字号倍率', () => {
  it('缺省与非法值回退到 100%', () => {
    expect(normalizeAdminFontScale(undefined)).toBe(DEFAULT_ADMIN_FONT_SCALE);
    expect(normalizeAdminFontScale(null)).toBe(1);
    expect(normalizeAdminFontScale('')).toBe(1);
    expect(normalizeAdminFontScale('abc')).toBe(1);
    expect(normalizeAdminFontScale(Number.NaN)).toBe(1);
  });

  it('把输入收敛到 80%–120%，并对齐 5% 一档', () => {
    expect(normalizeAdminFontScale(0.5)).toBe(ADMIN_FONT_SCALE_MIN);
    expect(normalizeAdminFontScale(2)).toBe(ADMIN_FONT_SCALE_MAX);
    expect(normalizeAdminFontScale('1.15')).toBe(1.15);
    expect(normalizeAdminFontScale(1.13)).toBe(1.15);
    expect(normalizeAdminFontScale(1.12)).toBe(1.1);
    expect(normalizeAdminFontScale(0.87)).toBe(0.85);
  });

  it('百分比展示不出现浮点小数', () => {
    expect(adminFontPercent(1)).toBe(100);
    expect(adminFontPercent(1.1500000000000001)).toBe(115);
    expect(adminFontPercent(0.85)).toBe(85);
    expect(adminFontPercent(9)).toBe(120);
  });
});
