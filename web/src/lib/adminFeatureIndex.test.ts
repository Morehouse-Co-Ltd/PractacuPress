import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_FEATURE_INDEX } from './adminFeatureIndex';
import { setLocale, t } from './i18n';

const CJK = /[\u3400-\u9fff]/;

afterEach(() => {
  setLocale('zh-CN');
});

describe('后台功能索引', () => {
  it('id 唯一，路由都在后台命名空间下', () => {
    const ids = ADMIN_FEATURE_INDEX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const badRoutes = ADMIN_FEATURE_INDEX.filter((entry) => !entry.to.startsWith('/admin')).map(
      (entry) => entry.to,
    );
    expect(badRoutes).toEqual([]);
  });

  it('每条功能都有英文翻译（英文界面下不能回退中文）', () => {
    setLocale('en');
    const missing = ADMIN_FEATURE_INDEX.filter(
      (entry) => CJK.test(entry.label) && t(entry.label) === entry.label,
    ).map((entry) => entry.label);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('英文标签里不含中文，占位符与原文一致', () => {
    setLocale('en');
    const dirty = ADMIN_FEATURE_INDEX.filter((entry) => {
      const translated = t(entry.label);
      return CJK.test(translated);
    }).map((entry) => entry.label);
    expect([...new Set(dirty)]).toEqual([]);
  });

  it('覆盖后台的每一类细节功能（抽样断言关键入口）', () => {
    const labels = new Set(ADMIN_FEATURE_INDEX.map((entry) => entry.label));
    for (const expected of [
      '回收站',
      '能力矩阵',
      'sitemap.xml',
      'robots.txt',
      'CORS 来源',
      'S3 兼容存储',
      '整库备份',
      '第三方登录',
      '订阅者',
      '操作日志',
      '平台总览',
    ]) {
      expect(labels.has(expected), expected).toBe(true);
    }
  });
});
