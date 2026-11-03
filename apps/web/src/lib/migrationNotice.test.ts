import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SEEN_SIGNATURES,
  SEEN_KEY,
  hasSeenMigrationReport,
  markMigrationReportSeen,
  migrationReportSignature,
  publishMigrationReport,
  takeMigrationReport,
} from './migrationNotice';

/**
 * 迁移报告的内存队列与「已读」记录。
 *
 * 注意顺序：最后一个用例故意让 `localStorage.setItem` 抛错，模块会就此退化到内存
 * （`degraded` 是模块级的一次性判断，见 lib/migrationNotice.ts），因此它必须放在
 * 文件末尾——否则同文件后面的存储用例都会走内存分支。
 */
beforeEach(() => {
  localStorage.clear();
  // 上一条用例发布的报告可能还留在模块内存里，先取走再开始。
  takeMigrationReport();
});

describe('迁移报告的内存队列', () => {
  it('publish 之后 take 只交出一次', () => {
    publishMigrationReport(['首页：已折算手机端。', '文章页：已折算平板端。']);

    expect(takeMigrationReport()).toEqual(['首页：已折算手机端。', '文章页：已折算平板端。']);
    expect(takeMigrationReport()).toEqual([]);
  });

  it('空报告不覆盖已有内容，什么都不做也不留痕迹', () => {
    publishMigrationReport(['首页：已折算手机端。']);
    publishMigrationReport([]);
    expect(takeMigrationReport()).toEqual(['首页：已折算手机端。']);

    publishMigrationReport([]);
    expect(takeMigrationReport()).toEqual([]);
  });

  it('丢掉落空的报告行', () => {
    publishMigrationReport(['首页：已折算手机端。', '   ']);
    expect(takeMigrationReport()).toEqual(['首页：已折算手机端。']);
  });
});

describe('迁移报告签名', () => {
  it('相同内容得到相同签名，与数组实例无关', () => {
    const report = ['首页：已折算手机端。', '页面「关于」：已折算手机端。'];
    expect(migrationReportSignature(report)).toBe(migrationReportSignature([...report]));
    expect(migrationReportSignature(report)).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });

  it('内容不同或行数不同就会变', () => {
    const base = migrationReportSignature(['首页：已折算手机端。']);
    expect(migrationReportSignature(['首页：已折算平板端。'])).not.toBe(base);
    expect(migrationReportSignature(['首页：已折算手机端。', '文章页：已折算手机端。'])).not.toBe(base);
    expect(migrationReportSignature([])).not.toBe(base);
  });
});

describe('已读签名', () => {
  it('标记后可以从 localStorage 读回来', () => {
    const signature = migrationReportSignature(['首页：已折算手机端。']);
    expect(hasSeenMigrationReport(signature)).toBe(false);

    markMigrationReportSeen(signature);

    expect(hasSeenMigrationReport(signature)).toBe(true);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')).toEqual([signature]);
    expect(hasSeenMigrationReport('别的报告')).toBe(false);
  });

  it('最多保留 20 条，最旧的先淘汰', () => {
    for (let index = 0; index < MAX_SEEN_SIGNATURES + 5; index += 1) {
      markMigrationReportSeen(`sig-${index}`);
    }

    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(MAX_SEEN_SIGNATURES);
    expect(stored[0]).toBe('sig-5');
    expect(stored[stored.length - 1]).toBe(`sig-${MAX_SEEN_SIGNATURES + 4}`);
    expect(hasSeenMigrationReport('sig-0')).toBe(false);
    expect(hasSeenMigrationReport(`sig-${MAX_SEEN_SIGNATURES + 4}`)).toBe(true);
  });

  it('重复标记不会占掉两条名额', () => {
    markMigrationReportSeen('sig-a');
    markMigrationReportSeen('sig-b');
    markMigrationReportSeen('sig-a');

    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')).toEqual(['sig-b', 'sig-a']);
  });

  it('localStorage 写不进去时不抛错，会话内仍然记得', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    expect(() => markMigrationReportSeen('sig-throw')).not.toThrow();
    // 退化到内存：同一次会话里不会再弹第二次。
    expect(hasSeenMigrationReport('sig-throw')).toBe(true);

    spy.mockRestore();
  });
});
