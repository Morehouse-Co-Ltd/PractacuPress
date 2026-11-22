import { describe, expect, it, vi } from 'vitest';
import {
  bytesToMbString,
  parseMediaQuotaInput,
  parseMediaQuotaMbInput,
} from './mediaQuota';

describe('parseMediaQuotaInput', () => {
  it('maps an empty input to inherited quota', () => {
    expect(parseMediaQuotaInput('')).toEqual({ valid: true, value: null });
  });

  it('accepts zero and exact whole bytes through the backend int64 limit', () => {
    expect(parseMediaQuotaInput('0')).toEqual({ valid: true, value: 0 });
    expect(parseMediaQuotaInput('104857600')).toEqual({ valid: true, value: 104857600 });
    expect(parseMediaQuotaInput(String(Number.MAX_SAFE_INTEGER))).toEqual({
      valid: true,
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(parseMediaQuotaInput('9007199254740993')).toEqual({
      valid: true,
      value: '9007199254740993',
    });
    expect(parseMediaQuotaInput('9223372036854775807')).toEqual({
      valid: true,
      value: '9223372036854775807',
    });
  });

  it('rejects negative, fractional, non-decimal, and inexact values', () => {
    for (const raw of ['-1', '1.5', '1e6', '1\n', 'not-a-number', '9223372036854775808']) {
      expect(parseMediaQuotaInput(raw), raw).toEqual({ valid: false });
    }
  });

  it('bounds long decimal input before converting it to a big integer', () => {
    const bigInt = vi.spyOn(globalThis, 'BigInt');
    try {
      expect(parseMediaQuotaInput('9'.repeat(64))).toEqual({ valid: false });
      expect(bigInt).not.toHaveBeenCalled();
    } finally {
      bigInt.mockRestore();
    }
  });

  it('normalizes arbitrarily long zero prefixes before validating the int64 value', () => {
    expect(parseMediaQuotaInput(`${'0'.repeat(100_000)}9007199254740993`)).toEqual({
      valid: true,
      value: '9007199254740993',
    });
  });
});

/** 界面单位是 MB，存储与接口始终是字节：这里钉住两边的换算规则。 */
describe('媒体额度的 MB 换算', () => {
  it('把字节值显示成去掉末尾零的 MB 字符串', () => {
    expect(bytesToMbString(null)).toBe('');
    expect(bytesToMbString(undefined)).toBe('');
    expect(bytesToMbString(0)).toBe('0');
    expect(bytesToMbString(1572864)).toBe('1.5');
    expect(bytesToMbString(1073741824)).toBe('1024');
    // 旧后端可能把 int64 当十进制字符串返回：换算同样精确，不丢位。
    expect(bytesToMbString('1073741824')).toBe('1024');
    expect(bytesToMbString('9223372036854775807')).toBe('8796093022207.999999');
  });

  it('把 MB 输入换算成四舍五入后的整数字节', () => {
    expect(parseMediaQuotaMbInput('')).toEqual({ valid: true, value: null });
    expect(parseMediaQuotaMbInput('0')).toEqual({ valid: true, value: 0 });
    expect(parseMediaQuotaMbInput('1.5')).toEqual({ valid: true, value: 1572864 });
    expect(parseMediaQuotaMbInput('0.5')).toEqual({ valid: true, value: 524288 });
  });

  it('拒绝负数、非数字与超出安全整数范围的字节数', () => {
    for (const raw of ['-1', '-0.5', 'abc', 'NaN', '1e3', '1,5', '1 024']) {
      expect(parseMediaQuotaMbInput(raw), raw).toEqual({ valid: false });
    }
    // 2^53 字节是安全整数的天花板（约 8589934591 MB）。
    expect(parseMediaQuotaMbInput('8589934591')).toEqual({
      valid: true,
      value: 9007199253692416,
    });
    expect(parseMediaQuotaMbInput('8589934592')).toEqual({ valid: false });
    expect(parseMediaQuotaMbInput('999999999999999999999')).toEqual({ valid: false });
  });
});
