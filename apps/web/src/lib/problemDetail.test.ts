import { describe, expect, it } from 'vitest';
import type { ProblemBody } from '../types';
import { ApiError } from './api';
import { KNOWN_DETAILS, problemDetail, problemDetailText } from './problemDetail';

function problem(details: Record<string, unknown>): ProblemBody {
  return {
    type: 'https://docs.practacu.press/errors/validation_failed',
    title: 'Validation failed',
    status: 400,
    code: 'validation_failed',
    message: '请求参数不符合要求',
    details,
    request_id: 'req-1',
  };
}

describe('problemDetail', () => {
  it('取出字段与规则', () => {
    expect(problemDetail(problem({ field: 'password', rule: 'too_weak' }))).toEqual({
      field: 'password',
      rule: 'too_weak',
    });
  });

  it('缺一个键就不猜', () => {
    expect(problemDetail(problem({ field: 'password' }))).toBeNull();
    expect(problemDetail(problem({ rule: 'too_weak' }))).toBeNull();
    expect(problemDetail(problem({}))).toBeNull();
  });

  it('非字符串、空串一律拒绝', () => {
    expect(problemDetail(problem({ field: 1, rule: 'too_weak' }))).toBeNull();
    expect(problemDetail(problem({ field: '', rule: 'too_weak' }))).toBeNull();
  });

  it('没有响应体时返回 null', () => {
    expect(problemDetail(null)).toBeNull();
    expect(problemDetail(undefined)).toBeNull();
  });
});

describe('problemDetailText', () => {
  const identity = (key: string) => key;

  it('每个认识的组合都能给出非空文案', () => {
    for (const detail of KNOWN_DETAILS) {
      const text = problemDetailText(detail, identity);
      expect(text, `${detail.field}:${detail.rule}`).toBeTruthy();
    }
  });

  it('密码不够强时说清楚缺什么', () => {
    const text = problemDetailText({ field: 'password', rule: 'too_weak' }, identity);
    expect(text).toContain('两类');
  });

  it('邮箱格式错误时提到邮箱', () => {
    const text = problemDetailText({ field: 'email', rule: 'malformed' }, identity);
    expect(text).toContain('邮箱');
  });

  it('不认识的组合返回 null，交给通用文案', () => {
    expect(problemDetailText({ field: 'password', rule: 'out_of_range' }, identity)).toBeNull();
    expect(problemDetailText({ field: 'nonsense', rule: 'required' }, identity)).toBeNull();
    expect(problemDetailText(null, identity)).toBeNull();
  });
});

describe('errorText 与 ApiError 的配合', () => {
  it('有具体字段时优先用具体文案，而不是通用那句', async () => {
    const { errorText } = await import('./i18n');
    const err = new ApiError(problem({ field: 'password', rule: 'too_weak' }));
    expect(errorText(err)).not.toBe('请求参数不符合要求');
    expect(errorText(err)).toContain('两类');
  });

  it('没有字段时保持原来的通用文案', async () => {
    const { errorText } = await import('./i18n');
    const err = new ApiError(problem({}));
    expect(errorText(err)).toBe('请求参数不符合要求');
  });
});
