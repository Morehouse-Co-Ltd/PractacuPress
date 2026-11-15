import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_SCENES,
  asProvider,
  captchaAction,
  captchaCellIndex,
  captchaEnvSnippet,
  captchaPointFromEvent,
  captchaProviderNeedsSiteKey,
  captchaReasonText,
  captchaSceneRequired,
  captchaScriptUrl,
  readCaptchaStatus,
  readLocalCaptchaChallenge,
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

describe('readLocalCaptchaChallenge', () => {
  it('滑块题读图形与几何字段', () => {
    const challenge = readLocalCaptchaChallenge({
      challenge_id: 'c1',
      kind: 'slider',
      prompt: '拖动滑块',
      expires_at: '2026-11-15T10:00:00Z',
      width: 320,
      height: 180,
      background: 'data:image/png;base64,aa',
      piece: 'data:image/png;base64,bb',
      piece_size: 52,
      piece_top: 40,
      max_offset: 268,
    });
    expect(challenge.kind).toBe('slider');
    expect(challenge.background).toContain('data:image/png');
    expect(challenge.piece).toContain('data:image/png');
    expect(challenge.piece_size).toBe(52);
    expect(challenge.piece_top).toBe(40);
    expect(challenge.max_offset).toBe(268);
    expect(challenge.image).toBeUndefined();
  });

  it('点击题读图片与目标数量', () => {
    const challenge = readLocalCaptchaChallenge({
      kind: 'click',
      width: 320,
      height: 200,
      image: 'data:image/png;base64,cc',
      target_count: 4,
    });
    expect(challenge.kind).toBe('click');
    expect(challenge.target_count).toBe(4);
    expect(challenge.image).toContain('data:image/png');
  });

  it('选择题补上网格缺省值', () => {
    const challenge = readLocalCaptchaChallenge({
      kind: 'select',
      image: 'data:image/png;base64,dd',
      target_count: 3,
    });
    expect(challenge.rows).toBe(3);
    expect(challenge.cols).toBe(3);
    expect(challenge.width).toBe(288);
    expect(challenge.height).toBe(288);
  });

  it('缺失或非法应答不会让渲染崩掉', () => {
    for (const raw of [null, undefined, {}, 'nope', []]) {
      const challenge = readLocalCaptchaChallenge(raw);
      expect(challenge.kind).toBe('slider');
      expect(challenge.challenge_id).toBe('');
      expect(challenge.width).toBeGreaterThan(0);
      expect(challenge.height).toBeGreaterThan(0);
      expect(challenge.max_offset).toBeGreaterThan(0);
    }
  });
});

describe('图片坐标系换算', () => {
  const rect = { left: 100, top: 50, width: 160, height: 100 };

  it('按显示尺寸缩放到原始像素', () => {
    // 图片被缩小一半：点在显示区域正中，应落到 320x200 图片的中心。
    const point = captchaPointFromEvent(rect, 180, 100, 320, 200);
    expect(point).toEqual({ x: 160, y: 100 });
  });

  it('越界的点击被忽略', () => {
    expect(captchaPointFromEvent(rect, 99, 100, 320, 200)).toBeNull();
    expect(captchaPointFromEvent(rect, 180, 151, 320, 200)).toBeNull();
    expect(captchaPointFromEvent({ ...rect, width: 0 }, 180, 100, 320, 200)).toBeNull();
  });

  it('九宫格按行优先给格子编号', () => {
    const size = { width: 288, height: 288, rows: 3, cols: 3 };
    expect(captchaCellIndex({ x: 10, y: 10 }, size.width, size.height, size.rows, size.cols)).toBe(0);
    expect(captchaCellIndex({ x: 150, y: 10 }, size.width, size.height, size.rows, size.cols)).toBe(1);
    expect(captchaCellIndex({ x: 150, y: 150 }, size.width, size.height, size.rows, size.cols)).toBe(4);
    expect(captchaCellIndex({ x: 287, y: 287 }, size.width, size.height, size.rows, size.cols)).toBe(8);
    expect(captchaCellIndex({ x: 288, y: 10 }, size.width, size.height, size.rows, size.cols)).toBeNull();
    expect(captchaCellIndex({ x: -1, y: 10 }, size.width, size.height, size.rows, size.cols)).toBeNull();
  });
});
