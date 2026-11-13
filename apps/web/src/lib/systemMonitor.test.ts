import { describe, expect, it } from 'vitest';
import {
  SYSTEM_HISTORY_LIMIT,
  SYSTEM_RING_CIRCUMFERENCE,
  SYSTEM_RING_RADIUS,
  appendSample,
  clampPercent,
  percentOf,
  ringDashOffset,
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
      history = appendSample(history, sample());
    }
    expect(history).toHaveLength(SYSTEM_HISTORY_LIMIT);
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
