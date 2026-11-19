import { describe, expect, it } from 'vitest';
import {
  SYSTEM_HISTORY_LIMIT,
  SYSTEM_HISTORY_WINDOW_MS,
  SYSTEM_RING_CIRCUMFERENCE,
  SYSTEM_RING_RADIUS,
  SYSTEM_SAMPLE_INTERVAL_MS,
  SYSTEM_STALE_AFTER_MS,
  appendSample,
  clampPercent,
  isSampleStale,
  percentOf,
  resourceSplit,
  ringDashOffset,
  sampleAgeMs,
  sparklinePath,
  uptimeParts,
} from './systemMonitor';
import type { SystemMetrics } from '../types';

function sample(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    sampled_at: '2026-11-12T12:00:00Z',
    platform: { os: 'windows', arch: 'amd64', hostname: 'box', uptime_seconds: 90061 },
    cpu: { usage_percent: 12.5, cores: 8, model: 'Test CPU' },
    memory: { total_bytes: 100, used_bytes: 40, free_bytes: 60, usage_percent: 40 },
    disk: { path: 'C:/data', total_bytes: 1000, used_bytes: 500, free_bytes: 500, usage_percent: 50 },
    app: {
      processes: [],
      cpu_percent: 2,
      memory_bytes: 10,
      storage: {
        data_dir: 'C:/data',
        total_bytes: 100,
        database_bytes: 30,
        media_bytes: 20,
        backup_bytes: 10,
        other_bytes: 40,
      },
    },
    others: { cpu_percent: 10.5, memory_bytes: 30, process_count: 120, top_processes: [] },
    ...overrides,
  };
}

describe('appendSample', () => {
  it('把采样并入曲线并夹紧 0–100', () => {
    const history = appendSample([], sample({ cpu: { usage_percent: 140, cores: 8, model: '' } }));
    expect(history).toHaveLength(1);
    expect(history[0].cpu).toBe(100);
    expect(history[0].memory).toBe(40);
    expect(history[0].at).toBe(Date.parse('2026-11-12T12:00:00Z'));
  });

  it('坏时间戳用当前时间兜底，不产生 NaN', () => {
    const history = appendSample([], sample({ sampled_at: 'not-a-date' }));
    expect(Number.isFinite(history[0].at)).toBe(true);
  });

  it('超出上限时丢最旧的点', () => {
    let history: ReturnType<typeof appendSample> = [];
    for (let index = 0; index < SYSTEM_HISTORY_LIMIT + 5; index += 1) {
      history = appendSample(
        history,
        sample({ sampled_at: new Date(Date.UTC(2026, 10, 12, 12, 0, index)).toISOString() }),
      );
    }
    expect(history).toHaveLength(SYSTEM_HISTORY_LIMIT);
    expect(history[history.length - 1].at).toBe(Date.UTC(2026, 10, 12, 12, 1, 4));
    expect(history[0].at).toBe(Date.UTC(2026, 10, 12, 12, 0, 5));
  });

  it('相同 sampled_at 只保留一个点，并更新它的数值', () => {
    const at = '2026-11-12T12:00:00Z';
    let history = appendSample([], sample({ sampled_at: at, cpu: { usage_percent: 10, cores: 8, model: '' } }));
    history = appendSample(
      history,
      sample({ sampled_at: at, cpu: { usage_percent: 80, cores: 8, model: '' } }),
    );
    expect(history).toHaveLength(1);
    expect(history[0].cpu).toBe(80);
  });

  it('乱序的旧样本直接丢弃，不插到曲线末尾', () => {
    const history = appendSample([], sample({ sampled_at: '2026-11-12T12:00:02Z' }));
    const next = appendSample(history, sample({ sampled_at: '2026-11-12T12:00:00Z' }));
    expect(next).toBe(history);
  });
});

describe('sparklinePath', () => {
  it('少于两个点返回空串（调用方画平线占位）', () => {
    expect(sparklinePath([], 100, 40)).toBe('');
    expect(sparklinePath([50], 100, 40)).toBe('');
  });

  it('数值越大 y 越小，并把 0–100 映射到画布内', () => {
    const path = sparklinePath([0, 100], 100, 40, 0);
    expect(path).toBe('M0 40 L100 0');
  });

  it('非法值按 0 处理，路径不含 NaN', () => {
    const path = sparklinePath([Number.NaN, 50, -10, 120], 100, 40);
    expect(path).not.toContain('NaN');
    expect(path.startsWith('M')).toBe(true);
  });
});

describe('percentOf / uptimeParts', () => {
  it('部分占总量的百分比带边界处理', () => {
    expect(percentOf(5, 10)).toBe(50);
    expect(percentOf(20, 10)).toBe(100);
    expect(percentOf(-1, 10)).toBe(0);
    expect(percentOf(1, 0)).toBe(0);
  });

  it('运行秒数拆成天/时/分', () => {
    expect(uptimeParts(90061)).toEqual({ days: 1, hours: 1, minutes: 1 });
    expect(uptimeParts(0)).toEqual({ days: 0, hours: 0, minutes: 0 });
    expect(uptimeParts(Number.NaN)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });
});

describe('resourceSplit 三段占比', () => {
  it('本软件 + 其他软件 + 空闲 = 100', () => {
    const split = resourceSplit(2, 3, 10);
    expect(split.app).toBeCloseTo(20, 10);
    expect(split.other).toBeCloseTo(30, 10);
    expect(split.idle).toBeCloseTo(50, 10);
    expect(split.app + split.other + split.idle).toBeCloseTo(100, 10);
  });

  it('CPU 按整机 100% 拆分时标签宽度与总量一致', () => {
    const split = resourceSplit(12.5, 20, 100);
    expect(split.app + split.other).toBeCloseTo(32.5, 10);
    expect(split.app + split.other + split.idle).toBeCloseTo(100, 10);
  });

  it('负数 / NaN / 非法总量都按 0 处理，不产生负宽度', () => {
    expect(resourceSplit(-5, 20, 100).app).toBe(0);
    expect(resourceSplit(5, Number.NaN, 100).other).toBe(0);
    expect(resourceSplit(5, 20, 0)).toEqual({ app: 0, other: 0, idle: 0 });
    const split = resourceSplit(Number.NaN, -1, Number.POSITIVE_INFINITY);
    expect(split).toEqual({ app: 0, other: 0, idle: 0 });
  });

  it('app + other 超过总量时截断其他软件，空闲段不为负', () => {
    const split = resourceSplit(8, 8, 10);
    expect(split.app).toBeCloseTo(80, 10);
    expect(split.other).toBeCloseTo(20, 10);
    expect(split.idle).toBe(0);
    expect(split.app + split.other).toBeLessThanOrEqual(100);
  });
});

describe('数据年龄与过期判定', () => {
  const at = '2026-11-12T12:00:00Z';
  const atMs = Date.parse(at);

  it('sampleAgeMs 用 now 计算年龄；本机时钟更慢时按 0', () => {
    expect(sampleAgeMs(at, atMs + 2500)).toBe(2500);
    expect(sampleAgeMs(at, atMs)).toBe(0);
    expect(sampleAgeMs(at, atMs - 1000)).toBe(0);
  });

  it('非法时间戳返回 null，不会产生 NaN 年龄', () => {
    expect(sampleAgeMs('not-a-date', atMs)).toBeNull();
    expect(sampleAgeMs(at, Number.NaN)).toBeNull();
  });

  it('超过 8 秒阈值才算过期', () => {
    expect(isSampleStale(at, atMs + 2000)).toBe(false);
    expect(isSampleStale(at, atMs + SYSTEM_STALE_AFTER_MS)).toBe(false);
    expect(isSampleStale(at, atMs + SYSTEM_STALE_AFTER_MS + 1)).toBe(true);
    expect(isSampleStale(at, atMs + 60_000)).toBe(true);
  });

  it('非法时间戳视为过期；阈值可以覆盖', () => {
    expect(isSampleStale('not-a-date', atMs)).toBe(true);
    expect(isSampleStale(at, atMs + 5000, 4000)).toBe(true);
    expect(isSampleStale(at, atMs + 5000, Number.NaN)).toBe(false);
  });

  it('曲线窗口与服务端采样节奏一致：约 2 分钟', () => {
    expect(SYSTEM_SAMPLE_INTERVAL_MS).toBe(2000);
    expect(SYSTEM_HISTORY_WINDOW_MS).toBeGreaterThanOrEqual(110_000);
    expect(SYSTEM_HISTORY_WINDOW_MS).toBeLessThanOrEqual(130_000);
  });
});

describe('圆环仪表盘的几何', () => {
  it('周长按半径 44 计算（页面 viewBox 120×120）', () => {
    expect(SYSTEM_RING_RADIUS).toBe(44);
    expect(SYSTEM_RING_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * 44, 10);
  });

  it('dashoffset 与百分比反向：0% 空环、50% 半环、100% 满环', () => {
    expect(ringDashOffset(0)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE, 10);
    expect(ringDashOffset(50)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE / 2, 10);
    expect(ringDashOffset(100)).toBeCloseTo(0, 10);
  });

  it('可以传入自定义周长（单测与未来小尺寸圆环共用同一公式）', () => {
    expect(ringDashOffset(25, 400)).toBeCloseTo(300, 10);
    expect(ringDashOffset(0, 400)).toBeCloseTo(400, 10);
    expect(ringDashOffset(100, 400)).toBeCloseTo(0, 10);
  });

  it('越界与非法百分比夹紧到 0–100，不产生负 offset / NaN', () => {
    expect(ringDashOffset(-20)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE, 10);
    expect(ringDashOffset(150)).toBeCloseTo(0, 10);
    expect(ringDashOffset(Number.NaN)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE, 10);
    expect(ringDashOffset(Number.POSITIVE_INFINITY)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE, 10);
    expect(ringDashOffset(50, Number.NaN)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE / 2, 10);
    expect(ringDashOffset(50, 0)).toBeCloseTo(SYSTEM_RING_CIRCUMFERENCE / 2, 10);
  });

  it('clampPercent 统一处理非法输入', () => {
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});
