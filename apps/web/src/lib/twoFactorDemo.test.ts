import { beforeEach, describe, expect, it } from 'vitest';
import { DemoBackend } from './demo';

/**
 * 演示模式的两步验证（FSD F-04）。
 *
 * 演示后端必须复现真实后端的语义：密码只完成第一步、恢复码一次性、关闭需要密码
 * 加验证码。真实后端的 RFC 6238 校验由 Go 测试覆盖，这里只验证浏览器本地的演示实现。
 */
describe('demo two-factor authentication', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('enables, challenges the next login and consumes recovery codes once', async () => {
    const backend = new DemoBackend();
    const first = await backend.login({ identifier: 'admin@practacu.local', password: 'practacu' });
    expect(first.status).toBe('session');
    if (first.status !== 'session') return;

    const enrollment = await backend.beginTwoFactorEnrollment('practacu');
    expect(enrollment.qr_content).toContain('otpauth://totp/');
    expect(enrollment.secret.length).toBeGreaterThan(10);

    const codes = await backend.confirmTwoFactor('123456');
    expect(codes.recovery_codes).toHaveLength(10);

    const status = await backend.twoFactorStatus();
    expect(status.enabled).toBe(true);
    expect(status.recovery_codes_remaining).toBe(10);

    // The password alone no longer starts a session.
    const second = await backend.login({ identifier: 'admin@practacu.local', password: 'practacu' });
    expect(second.status).toBe('two_factor_required');
    if (second.status !== 'two_factor_required') return;

    const session = await backend.loginTwoFactor(second.challenge.challenge_token, '123456');
    expect(session.access_token).toContain('demo.');

    // A recovery code signs in once, then is dead.
    const third = await backend.login({ identifier: 'admin@practacu.local', password: 'practacu' });
    expect(third.status).toBe('two_factor_required');
    if (third.status !== 'two_factor_required') return;
    await backend.loginTwoFactor(third.challenge.challenge_token, codes.recovery_codes[0]);

    const fourth = await backend.login({ identifier: 'admin@practacu.local', password: 'practacu' });
    expect(fourth.status).toBe('two_factor_required');
    if (fourth.status !== 'two_factor_required') return;
    await expect(
      backend.loginTwoFactor(fourth.challenge.challenge_token, codes.recovery_codes[0]),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // Disabling needs the password and a working factor; the password alone is refused.
    await expect(
      backend.disableTwoFactor({ password: 'practacu', code: '000000' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await backend.disableTwoFactor({ password: 'practacu', code: '123456' });
    expect((await backend.twoFactorStatus()).enabled).toBe(false);

    const plain = await backend.login({ identifier: 'admin@practacu.local', password: 'practacu' });
    expect(plain.status).toBe('session');
    expect((await backend.me()).user.id).toBe(first.session.user.id);
  });
});
