import { describe, expect, it } from 'vitest';
import { isVisibleAt } from './visibility';

const now = new Date('2026-11-03T12:00:00Z');
const ctx = (role: 'guest' | 'member' | 'admin' = 'guest', device: 'desktop' | 'mobile' = 'desktop') => ({
  role,
  device,
  now,
});

describe('isVisibleAt', () => {
  it('没有 visible 就是可见', () => {
    expect(isVisibleAt({}, ctx())).toBe(true);
  });

  it('设备白名单', () => {
    const block = { visible: { devices: ['mobile' as const] } };
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'desktop'))).toBe(false);
  });

  it('角色白名单', () => {
    const block = { visible: { roles: ['member' as const, 'admin' as const] } };
    expect(isVisibleAt(block, ctx('guest'))).toBe(false);
    expect(isVisibleAt(block, ctx('member'))).toBe(true);
  });

  it('时间窗前可见、窗内可见、窗后不可见', () => {
    const block = { visible: { from: '2026-11-01', to: '2026-11-10' } };
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-10-31T00:00:00Z') })).toBe(false);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-05T00:00:00Z') })).toBe(true);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-11T00:00:00Z') })).toBe(false);
  });

  it('坏日期一律当作没有这个限制，不抛异常', () => {
    const block = { visible: { from: 'not-a-date' } };
    expect(() => isVisibleAt(block, ctx())).not.toThrow();
    expect(isVisibleAt(block, ctx())).toBe(true);
  });

  it('三个条件同时存在时全部满足才可见', () => {
    const block = {
      visible: { devices: ['mobile' as const], roles: ['member' as const], from: '2026-11-01' },
    };
    expect(isVisibleAt(block, ctx('member', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(false);
    expect(isVisibleAt(block, ctx('member', 'desktop'))).toBe(false);
  });
});
