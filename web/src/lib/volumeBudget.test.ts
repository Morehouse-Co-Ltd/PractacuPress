import { describe, expect, it } from 'vitest';
import {
  COVER_DATA_URL_MAX,
  DESIGN_SOFT_LIMIT_BYTES,
  PROPS_MAX_BYTES,
  designVolumeReport,
  normalizeBlockProps,
  normalizeCoverUrl,
} from './customize';

describe('体积预算', () => {
  it('封面 data URL 超过 64 KB 被丢弃', () => {
    const huge = `data:image/png;base64,${'A'.repeat(COVER_DATA_URL_MAX + 10)}`;
    const report = designVolumeReport({ covers: [{ id: 'c1', url: huge }] });
    expect(report.bytes).toBeLessThan(DESIGN_SOFT_LIMIT_BYTES);
    // 预算不是在写入时截断，而是整条丢弃：截断的 data URL 就是一张坏图。
    expect(normalizeCoverUrl(huge)).toBe('');
    expect(normalizeCoverUrl(`data:image/png;base64,${'A'.repeat(1024)}`)).not.toBe('');
  });

  it('单块 props 超过 8 KB 的部分不再计入', () => {
    const big = 'x'.repeat(PROPS_MAX_BYTES + 100);
    const report = designVolumeReport({ home: { blocks: [{ id: 'a', type: 'text', props: { body: big } }] } });
    expect(report.bytes).toBeLessThan(PROPS_MAX_BYTES + 1024);

    // 单个值本身有 4000 字符上限，所以真正会撑爆预算的是媒体内联图：它虽然在
    // normalizeMediaUrl 的白名单里，但超过单块 8 KB 预算时整条丢弃、其余键保留。
    const inline = `data:image/png;base64,${'A'.repeat(PROPS_MAX_BYTES + 1000)}`;
    const props = normalizeBlockProps('image', { src: inline, alt: '图' });
    expect(props.src).toBeUndefined();
    expect(props.alt).toBe('图');
  });

  it('正常设计不触发软警告', () => {
    expect(designVolumeReport({ home: { blocks: [] } }).soft).toBe(false);
  });

  it('越过 512 KB 软警告线时标记 soft', () => {
    const report = designVolumeReport({ custom_css: 'x'.repeat(DESIGN_SOFT_LIMIT_BYTES + 1) });
    expect(report.soft).toBe(true);
    expect(report.bytes).toBeGreaterThan(DESIGN_SOFT_LIMIT_BYTES);
  });
});
