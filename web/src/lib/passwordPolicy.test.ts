import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from './commonPasswords';
import {
  passwordClasses,
  passwordCreationProblem,
  passwordProblem,
  passwordProblemText,
  weakPasswordProblem,
} from './passwordPolicy';

/**
 * 这些用例与 `internal/auth/validation.go` 的 `ValidatePassword` 一一对应。
 *
 * 前端校验的意义不是"更严格"，而是**与后端一致**——只要比后端松，用户就会在
 * 提交后收到一句笼统的「请求参数不符合要求」，而真正的原因藏在 details 里。
 */
describe('passwordProblem', () => {
  it('长度不足 12 位', () => {
    expect(passwordProblem('GoodPass12!')).toBe('short'); // 11 个码点
  });

  it('刚好 12 位的强密码通过', () => {
    expect(passwordProblem('GoodPass123!')).toBeNull();
  });

  it('超过 128 位', () => {
    expect(passwordProblem('a1'.repeat(65))).toBe('long');
  });

  it('只有空格（长度够 12，所以命中空白规则而不是长度规则）', () => {
    expect(passwordProblem('            ')).toBe('blank');
  });

  it('常见弱口令被拒绝，且忽略大小写', () => {
    expect(passwordProblem('Password1234')).toBe('common');
    expect(passwordProblem('PASSWORD1234')).toBe('common');
    expect(passwordProblem('qwerty123456')).toBe('common');
    expect(passwordProblem('1q2w3e4r5t6y')).toBe('common');
  });

  it('常见弱口令黑名单与后端同量级，并含经典条目', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(300);
    for (const classic of ['password', '123456', 'qwerty', 'letmein', 'iloveyou', 'admin', 'welcome', 'passw0rd', '1q2w3e4r']) {
      expect(COMMON_PASSWORDS.has(classic), classic).toBe(true);
    }
  });

  it('只是包含常见词的更长口令不被误判为常见弱口令', () => {
    expect(passwordProblem('my Password1234 passphrase')).toBeNull();
  });

  it('单一字符类被拒绝：纯小写', () => {
    expect(passwordProblem('passwordpassword')).toBe('classes');
  });

  it('单一字符类被拒绝：纯大写', () => {
    expect(passwordProblem('PASSWORDPASSWORD')).toBe('classes');
  });

  it('单一字符类被拒绝：纯数字', () => {
    expect(passwordProblem('908172635410')).toBe('classes');
  });

  it('纯中文算一类（服务端把无大小写字母记作字母类），同样被拒绝', () => {
    expect(passwordProblem('密码密码密码密码密码密码')).toBe('classes');
  });

  it('字母 + 数字两类，通过', () => {
    expect(passwordProblem('pass1234pass')).toBeNull();
  });

  it('符号算一类：纯小写 + 符号也通过', () => {
    expect(passwordProblem('pass!!!!pass')).toBeNull();
  });

  it('中文 + 数字两类，通过', () => {
    expect(passwordProblem('密码密码密码密码密码密码1')).toBeNull();
  });

  it('大写 + 数字两类，通过', () => {
    expect(passwordProblem('ABCDEF123456')).toBeNull();
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

describe('passwordCreationProblem', () => {
  it('空串、纯空白和超长密码即使确认也不能保存', () => {
    expect(passwordCreationProblem('', true)).toBe('short');
    expect(passwordCreationProblem('   ', true)).toBe('blank');
    expect(passwordCreationProblem('a1'.repeat(65), true)).toBe('long');
  });

  it('未确认时沿用严格策略', () => {
    expect(passwordCreationProblem('GoodPass12!')).toBe('short');
    expect(passwordCreationProblem('Password1234')).toBe('common');
    expect(passwordCreationProblem('passwordpassword')).toBe('classes');
    expect(passwordCreationProblem('GoodPass123!')).toBeNull();
  });

  it('确认后接受弱密码和强密码', () => {
    expect(passwordCreationProblem('short', true)).toBeNull();
    expect(passwordCreationProblem('Password1234', true)).toBeNull();
    expect(passwordCreationProblem('passwordpassword', true)).toBeNull();
    expect(passwordCreationProblem('GoodPass123!', true)).toBeNull();
  });
});

describe('weakPasswordProblem', () => {
  it('只把可确认的弱密码交还给弹窗', () => {
    expect(weakPasswordProblem('short')).toBe('short');
    expect(weakPasswordProblem('Password1234')).toBe('common');
    expect(weakPasswordProblem('passwordpassword')).toBe('classes');
  });

  it('强密码、空密码、纯空白和超长密码不弹确认框', () => {
    expect(weakPasswordProblem('GoodPass123!')).toBeNull();
    expect(weakPasswordProblem('')).toBeNull();
    expect(weakPasswordProblem('   ')).toBeNull();
    expect(weakPasswordProblem('a1'.repeat(65))).toBeNull();
  });
});

describe('passwordProblemText', () => {
  it('每个错误码都有可显示文案', () => {
    const identity = (key: string) => key;
    expect(passwordProblemText('short', identity)).toContain('12');
    expect(passwordProblemText('long', identity)).toContain('128');
    expect(passwordProblemText('blank', identity)).toContain('空格');
    expect(passwordProblemText('common', identity)).toContain('常见弱口令');
    expect(passwordProblemText('classes', identity)).toContain('两类');
  });
});
