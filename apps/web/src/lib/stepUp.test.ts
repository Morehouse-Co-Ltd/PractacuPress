import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStepUpToken,
  DEFAULT_DEMO_STEP_UP,
  DEMO_STEP_UP_KEY,
  getStepUpToken,
  isProtectedAction,
  isStepUpTokenValid,
  normalizeStepUpSettings,
  readDemoStepUpSettings,
  saveDemoStepUpSettings,
  STEP_UP_SESSION_KEY,
  storeStepUpToken,
  type StepUpStorage,
} from './stepUp';

/** 只实现用到的三个方法，避免测试把数据写进真实 localStorage。 */
function memoryStorage(seed?: Record<string, string>): StepUpStorage {
  const data = new Map(Object.entries(seed ?? {}));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  clearStepUpToken();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  clearStepUpToken();
  localStorage.clear();
  sessionStorage.clear();
});

describe('step-up 令牌仓库', () => {
  it('在 expires_in 之前复用，到点后自动失效', () => {
    storeStepUpToken('token-abc', 60, { now: 1_000 });
    expect(getStepUpToken(1_000)).toBe('token-abc');
    expect(getStepUpToken(60_999)).toBe('token-abc');
    // 到点即失效：不能把过期令牌发给服务端。
    expect(getStepUpToken(61_000)).toBeNull();
    expect(isStepUpTokenValid(61_000)).toBe(false);
  });

  it('存进 sessionStorage：同一次浏览器会话刷新后仍然可用', () => {
    storeStepUpToken('token-session', 60, { now: 1_000 });
    const raw = sessionStorage.getItem(STEP_UP_SESSION_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(parsed.token).toBe('token-session');
    expect(parsed.expires_at).toBe(61_000);
    // 不落到 localStorage：关闭浏览器后必须重新验证。
    expect(localStorage.getItem(STEP_UP_SESSION_KEY)).toBeNull();
  });

  it('expires_in 非正数或非法时不缓存令牌', () => {
    for (const expiresIn of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      storeStepUpToken('token', expiresIn, { now: 1_000 });
      expect(getStepUpToken(1_000)).toBeNull();
    }
  });

  it('换账户或换站点后旧令牌立即作废', () => {
    storeStepUpToken('token-abc', 600, { now: 1_000, userId: 'u1', siteId: 's1' });
    expect(getStepUpToken(2_000, { userId: 'u1', siteId: 's1' })).toBe('token-abc');
    expect(getStepUpToken(2_000, { userId: 'u2', siteId: 's1' })).toBeNull();
    // 作废之后就真的没了，换回原账户也不能复活。
    expect(getStepUpToken(2_000, { userId: 'u1', siteId: 's1' })).toBeNull();

    storeStepUpToken('token-abc', 600, { now: 1_000, userId: 'u1', siteId: 's1' });
    expect(getStepUpToken(2_000, { userId: 'u1', siteId: 's2' })).toBeNull();
  });

  it('sessionStorage 里是坏数据时按无令牌处理', () => {
    sessionStorage.setItem(STEP_UP_SESSION_KEY, '{broken');
    expect(getStepUpToken(1_000)).toBeNull();
    sessionStorage.setItem(STEP_UP_SESSION_KEY, JSON.stringify({ token: 'x', expires_at: 'soon' }));
    expect(getStepUpToken(1_000)).toBeNull();
  });

  it('可以主动清除令牌', () => {
    storeStepUpToken('token', 300, { now: 1_000 });
    expect(isStepUpTokenValid(2_000)).toBe(true);
    clearStepUpToken();
    expect(getStepUpToken(2_000)).toBeNull();
    expect(isStepUpTokenValid(2_000)).toBe(false);
    expect(sessionStorage.getItem(STEP_UP_SESSION_KEY)).toBeNull();
  });

  it('空令牌一律视为无效', () => {
    storeStepUpToken('', 300, { now: 1_000 });
    expect(getStepUpToken(1_000)).toBeNull();
  });
});

describe('isProtectedAction', () => {
  it('识别服务端守卫保护的动作', () => {
    expect(isProtectedAction('member.delete')).toBe(true);
    expect(isProtectedAction('member.role')).toBe(true);
    expect(isProtectedAction('member.two_factor_reset')).toBe(true);
    expect(isProtectedAction('site.import')).toBe(true);
  });

  it('普通动作与未知动作不算高危', () => {
    expect(isProtectedAction('content.publish')).toBe(false);
    expect(isProtectedAction('comment.create')).toBe(false);
    expect(isProtectedAction('')).toBe(false);
    // 大小写敏感：拼错的动作不会被误判成受保护。
    expect(isProtectedAction('MEMBER.DELETE')).toBe(false);
  });
});

describe('演示模式的保护设置', () => {
  it('默认开启保护且没有专用密码', () => {
    expect(readDemoStepUpSettings()).toEqual(DEFAULT_DEMO_STEP_UP);
    expect(DEFAULT_DEMO_STEP_UP.enabled).toBe(true);
    expect(DEFAULT_DEMO_STEP_UP.password_set).toBe(false);
  });

  it('开关持久化到注入的存储里，且不保存任何密码字段', () => {
    const storage = memoryStorage();
    const saved = saveDemoStepUpSettings({ enabled: false }, storage);
    expect(saved.enabled).toBe(false);
    expect(readDemoStepUpSettings(storage)).toEqual(saved);

    const raw = storage.getItem(DEMO_STEP_UP_KEY) ?? '';
    expect(raw).not.toBe('');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({ enabled: false, password_set: false, window_seconds: 604800 });
    expect(parsed).not.toHaveProperty('password');
    expect(parsed).not.toHaveProperty('password_hash');
  });

  it('clear_password 只清掉“设置过专用密码”的标记', () => {
    const storage = memoryStorage({
      [DEMO_STEP_UP_KEY]: JSON.stringify({
        enabled: true,
        password_set: true,
        window_seconds: 120,
      }),
    });
    const cleared = saveDemoStepUpSettings({ clear_password: true }, storage);
    expect(cleared).toEqual({ enabled: true, password_set: false, window_seconds: 120 });
  });

  it('存储里是坏 JSON 时回退默认值，不抛异常', () => {
    const storage = memoryStorage({ [DEMO_STEP_UP_KEY]: '{broken' });
    expect(readDemoStepUpSettings(storage)).toEqual(DEFAULT_DEMO_STEP_UP);
  });
});

describe('normalizeStepUpSettings', () => {
  it('字段类型不对时收敛到合法值', () => {
    expect(normalizeStepUpSettings({ enabled: 'yes', password_set: 1, window_seconds: -3 })).toEqual({
      enabled: true,
      password_set: false,
      window_seconds: 604800,
    });
    expect(normalizeStepUpSettings({ enabled: false, password_set: true, window_seconds: 90.9 })).toEqual({
      enabled: false,
      password_set: true,
      window_seconds: 90,
    });
  });

  it('null / 非对象回退默认值', () => {
    expect(normalizeStepUpSettings(null)).toEqual(DEFAULT_DEMO_STEP_UP);
    expect(normalizeStepUpSettings('x')).toEqual(DEFAULT_DEMO_STEP_UP);
  });
});
