import { describe, expect, it } from 'vitest';
import type { BackupArtifact } from '../types';
import {
  BACKUP_STALE_DAYS,
  backupAgeDays,
  backupHealthTone,
  backupTotals,
  latestBackup,
} from './backupHealth';

function artifact(overrides: Partial<BackupArtifact> = {}): BackupArtifact {
  return {
    id: 'b1',
    file_name: 'backup-1.zip',
    size: 1000,
    sha256: 'a'.repeat(64),
    created_at: '2026-11-20T10:00:00Z',
    driver: 'sqlite',
    dialect: 'sqlite',
    includes_media: true,
    ...overrides,
  };
}

describe('latestBackup', () => {
  it('空列表返回 null', () => {
    expect(latestBackup([])).toBeNull();
  });

  it('按 created_at 取最新，而不是按数组顺序', () => {
    const older = artifact({ id: 'old', created_at: '2026-11-18T10:00:00Z' });
    const newer = artifact({ id: 'new', created_at: '2026-11-21T10:00:00Z' });
    expect(latestBackup([older, newer])?.id).toBe('new');
    expect(latestBackup([newer, older])?.id).toBe('new');
  });

  it('时间戳非法时退回第一个，不产生 NaN', () => {
    const broken = artifact({ id: 'broken', created_at: 'not-a-date' });
    const valid = artifact({ id: 'valid', created_at: '2026-11-21T10:00:00Z' });
    expect(latestBackup([broken, valid])?.id).toBe('valid');
    expect(latestBackup([broken])?.id).toBe('broken');
  });
});

describe('backupTotals', () => {
  it('累加合法体积，并统计含媒体的份数', () => {
    const totals = backupTotals([
      artifact({ size: 1000, includes_media: true }),
      artifact({ id: 'b2', size: 500, includes_media: false }),
    ]);
    expect(totals).toEqual({ count: 2, bytes: 1500, withMedia: 1 });
  });

  it('负数 / NaN 体积不计入合计', () => {
    const totals = backupTotals([
      artifact({ size: Number.NaN }),
      artifact({ id: 'b2', size: -5 }),
      artifact({ id: 'b3', size: 200 }),
    ]);
    expect(totals.bytes).toBe(200);
    expect(totals.count).toBe(3);
  });
});

describe('backupAgeDays / backupHealthTone', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');

  it('按整天计算年龄，时钟偏差按 0', () => {
    expect(backupAgeDays('2026-11-21T10:00:00Z', now)).toBe(0);
    expect(backupAgeDays('2026-11-19T12:00:00Z', now)).toBe(2);
    expect(backupAgeDays('2026-11-22T12:00:00Z', now)).toBe(0);
    expect(backupAgeDays(undefined, now)).toBeNull();
    expect(backupAgeDays('not-a-date', now)).toBeNull();
  });

  it('没有备份是 muted，超过 7 天是 warn，其余 ok', () => {
    expect(backupHealthTone(null, now)).toBe('muted');
    expect(
      backupHealthTone(artifact({ created_at: '2026-11-21T11:00:00Z' }), now),
    ).toBe('ok');
    expect(
      backupHealthTone(artifact({ created_at: '2026-11-13T11:00:00Z' }), now),
    ).toBe('warn');
    expect(
      backupHealthTone(artifact({ created_at: '2026-11-14T12:00:00Z' }), now),
    ).toBe('ok');
    expect(
      backupHealthTone(artifact({ created_at: '2026-11-13T12:00:00Z' }), now),
    ).toBe('warn');
    expect(
      backupHealthTone(artifact({ created_at: '2026-11-15T12:00:00Z' }), now),
    ).toBe('ok');
    expect(backupHealthTone(artifact({ created_at: 'not-a-date' }), now)).toBe('muted');
  });

  it('阈值常量与文案约定一致', () => {
    expect(BACKUP_STALE_DAYS).toBe(7);
  });
});
