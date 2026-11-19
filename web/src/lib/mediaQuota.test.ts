import { describe, expect, it, vi } from 'vitest';
import { parseMediaQuotaInput } from './mediaQuota';

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
