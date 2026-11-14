import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_SCENES,
  asProvider,
  captchaAction,
  captchaEnvSnippet,
  captchaProviderNeedsSiteKey,
  captchaReasonText,
  captchaSceneRequired,
  captchaScriptUrl,
  readCaptchaStatus,
} from './captcha';

describe('readCaptchaStatus', () => {
  it('把服务端应答收敛成固定形状', () => {
    const status = readCaptchaStatus({
      enabled: true,
      provider: 'hcaptcha',
      site_key: 'key',
      scenes: { login: true, register: false, password_reset: true, comment: true },
      server_configured: true,
      effective: true,
      checked_at: '2026-11-07T10:00:00Z',
    });

    expect(status.provider).toBe('hcaptcha');
    expect(status.effective).toBe(true);
    expect(status.scenes.login).toBe(true);
    expect(status.scenes.register).toBe(false);
    expect(status.scenes.comment).toBe(true);
  });

  it('缺失或非法应答按未启用处理', () => {
    for (const raw of [null, undefined, {}, 'nope', [], { enabled: 'yes', provider: 'x' }]) {
      const status = readCaptchaStatus(raw);
      expect(status.enabled).toBe(false);
      expect(status.effective).toBe(false);
      expect(status.provider).toBe('turnstile');
      expect(status.site_key).toBe('');
      for (const scene of CAPTCHA_SCENES) expect(status.scenes[scene]).toBe(false);
    }
  });

  it('旧的 recaptcha 配置按 turnstile 读，不会因为服务商被移除而失效', () => {
    expect(asProvider('recaptcha')).toBe('turnstile');
    const status = readCaptchaStatus({ provider: 'recaptcha', enabled: true, effective: true });
    expect(status.provider).toBe('turnstile');
  });

  it('识别本地（自托管）服务商', () => {
    const status = readCaptchaStatus({ provider: 'local', effective: true });
    expect(status.provider).toBe('local');
  });

  it('场景表总是包含全部场景', () => {
    const status = readCaptchaStatus({ scenes: { login: true } });
    expect(Object.keys(status.scenes).sort()).toEqual([...CAPTCHA_SCENES].sort());
  });
});

describe('captchaSceneRequired', () => {
  const base = readCaptchaStatus({
    enabled: true,
    provider: 'turnstile',
    site_key: 'k',
    scenes: { login: true, register: true, password_reset: true, comment: false },
    server_configured: true,
    effective: true,
  });

  it('只有 effective 且该场景为真时才要求验证', () => {
    expect(captchaSceneRequired(base, 'login')).toBe(true);
    expect(captchaSceneRequired(base, 'comment')).toBe(false);
    expect(captchaSceneRequired(null, 'login')).toBe(false);
  });

  it('站点开关打开但服务端没密钥（effective=false）时不挂组件', () => {
    const unenforced = readCaptchaStatus({
      enabled: true,
      provider: 'turnstile',
      site_key: 'k',
      scenes: { login: true, register: true, password_reset: true, comment: true },
      server_configured: false,
      effective: false,
    });
    expect(captchaSceneRequired(unenforced, 'login')).toBe(false);
  });
});

describe('captchaScriptUrl', () => {
  it('按服务商给出脚本地址', () => {
    expect(captchaScriptUrl('turnstile')).toContain('challenges.cloudflare.com');
    expect(captchaScriptUrl('hcaptcha')).toContain('js.hcaptcha.com');
  });

  it('本地验证不加载任何外部脚本', () => {
    expect(captchaScriptUrl('local')).toBe('');
  });
});

describe('captchaProviderNeedsSiteKey', () => {
  it('只有本地验证不需要 Site Key', () => {
    expect(captchaProviderNeedsSiteKey('turnstile')).toBe(true);
    expect(captchaProviderNeedsSiteKey('hcaptcha')).toBe(true);
    expect(captchaProviderNeedsSiteKey('local')).toBe(false);
  });
});

describe('captchaAction', () => {
  it('action 与服务端场景名一致', () => {
    expect(captchaAction('login')).toBe('login');
    expect(captchaAction('register')).toBe('register');
    expect(captchaAction('password_reset')).toBe('password_reset');
    expect(captchaAction('comment')).toBe('comment');
  });
});

describe('captchaEnvSnippet', () => {
  it('使用后端真正读取的环境变量名', () => {
    expect(captchaEnvSnippet('turnstile')).toContain('CAPTCHA_TURNSTILE_SECRET');
    expect(captchaEnvSnippet('hcaptcha')).toContain('CAPTCHA_HCAPTCHA_SECRET');
  });

  it('本地验证片段说明不需要密钥', () => {
    const snippet = captchaEnvSnippet('local');
    expect(snippet).not.toContain('CAPTCHA_TURNSTILE_SECRET');
    expect(snippet).not.toContain('CAPTCHA_HCAPTCHA_SECRET');
    expect(snippet.toLowerCase()).toContain('no secret');
  });
});

describe('captchaReasonText', () => {
  const t = (text: string) => text;

  it('把服务端 reason 翻成可读说明', () => {
    expect(captchaReasonText('captcha_required', t)).toContain('人机验证');
    expect(captchaReasonText('captcha_replayed', t)).toContain('用过了');
    expect(captchaReasonText('captcha_unavailable', t)).toContain('连不上');
  });

  it('未知原因返回空串，交给调用方兜底', () => {
    expect(captchaReasonText(undefined, t)).toBe('');
    expect(captchaReasonText('something_else', t)).toBe('');
  });
});
