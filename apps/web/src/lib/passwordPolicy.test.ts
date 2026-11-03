import { describe, expect, it } from 'vitest';
import { passwordClasses, passwordProblem, passwordProblemText } from './passwordPolicy';

/**
 * 这些用例与 `apps/api/internal/auth/validation.go` 的 `ValidatePassword` 一一对应。
 *
 * 前端校验的意义不是"更严格"，而是**与后端一致**——只要比后端松，用户就会在
 * 提交后收到一句笼统的「请求参数不符合要求」，而真正的原因藏在 details 里。
 */
describe('passwordProblem', () => {
  it('长度不足 8 位', () => {
    expect(passwordProblem('pass123')).toBe('short');
  });

  it('超过 128 位', () => {
    expect(passwordProblem('a1'.repeat(65))).toBe('long');
  });

  it('只有空格', () => {
    expect(passwordProblem('        ')).toBe('blank');
  });

  it('单一字符类被拒绝：纯小写', () => {
    expect(passwordProblem('password')).toBe('classes');
  });

  it('单一字符类被拒绝：纯大写', () => {
    expect(passwordProblem('PASSWORD')).toBe('classes');
  });

  it('单一字符类被拒绝：纯数字', () => {
    expect(passwordProblem('12345678')).toBe('classes');
  });

  it('纯中文算一类（服务端把无大小写字母记作字母类），同样被拒绝', () => {
    expect(passwordProblem('密码密码密码密码')).toBe('classes');
  });

  it('字母 + 数字两类，通过', () => {
    expect(passwordProblem('pass1234')).toBeNull();
  });

  it('符号算一类：纯小写 + 符号也通过', () => {
    expect(passwordProblem('password!')).toBeNull();
  });

  it('中文 + 数字两类，通过', () => {
    expect(passwordProblem('密码密码1234')).toBeNull();
  });

  it('大写 + 数字两类，通过', () => {
    expect(passwordProblem('PASSWORD1')).toBeNull();
  });

  it('长度按码点数算，不按字节算：64 个中文字符加 4 位数字仍在 128 以内', () => {
    expect(passwordProblem('密码'.repeat(32) + '1234')).toBeNull();
  });
});

describe('passwordClasses', () => {
  it('分别统计四类字符', () => {
    expect(passwordClasses('abcd')).toBe(1);
    expect(passwordClasses('abcd1234')).toBe(2);
    expect(passwordClasses('Abcd1234')).toBe(3);
    expect(passwordClasses('Abcd1234!')).toBe(4);
  });

  it('中文与英文小写同属字母类', () => {
    expect(passwordClasses('中文abc')).toBe(1);
  });
});

describe('passwordProblemText', () => {
  it('每个错误码都有可显示文案', () => {
    const identity = (key: string) => key;
    expect(passwordProblemText('short', identity)).toContain('8');
    expect(passwordProblemText('long', identity)).toContain('128');
    expect(passwordProblemText('blank', identity)).toContain('空格');
    expect(passwordProblemText('classes', identity)).toContain('两类');
  });
});
