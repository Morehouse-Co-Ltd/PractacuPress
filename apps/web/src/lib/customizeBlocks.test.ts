import { describe, expect, it } from 'vitest';
import { blockBudgetStatus, normalizeScreenLayout } from './customize';

function textBlock(id: string) {
  return { id, type: 'text', title: id, props: { body: 'hi' }, animation: 'none' as const, hidden: false };
}

describe('normalizeScreenLayout', () => {
  it('保留不认识的区块类型并打上 unsupported', () => {
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'x1', type: 'pricing-v9', title: '价格', props: { plan: 'A' } }],
    });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0].type).toBe('pricing-v9');
    expect(layout.blocks[0].unsupported).toBe(true);
    expect(layout.blocks[0].props).toEqual({ plan: 'A' });
  });

  it('根级不再截断到 24 个', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`));
    const layout = normalizeScreenLayout({ blocks });
    expect(layout.blocks).toHaveLength(30);
  });

  it('容器子区块仍受 80 条上限约束', () => {
    const children = Array.from({ length: 90 }, (_, i) => textBlock(`c${i}`));
    const layout = normalizeScreenLayout({
      blocks: [
        { id: 'box', type: 'container', title: 'box', props: {}, animation: 'none', hidden: false, children },
      ],
    });
    expect(layout.blocks[0].children).toHaveLength(80);
  });

  it('没有任何 type 的条目直接丢弃', () => {
    const layout = normalizeScreenLayout({ blocks: [{ id: 'bad' }, textBlock('ok')] });
    expect(layout.blocks.map((block) => block.id)).toEqual(['ok']);
  });
});

describe('blockBudgetStatus', () => {
  it('超过 200 个区块时报告超限', () => {
    const blocks = Array.from({ length: 201 }, (_, i) => textBlock(`b${i}`));
    const status = blockBudgetStatus({ blocks });
    expect(status.over).toBe(true);
    expect(status.limit).toBe(200);
  });

  it('正常编排不超限', () => {
    expect(blockBudgetStatus({ blocks: [textBlock('a')] }).over).toBe(false);
  });

  it('计入分设备布局：设备树里的区块也算进总量', () => {
    const blocks = [textBlock('a')];
    const status = blockBudgetStatus({
      blocks,
      device_split: true,
      devices: { mobile: { blocks: [textBlock('m1'), textBlock('m2')] } },
    });
    expect(status.total).toBe(2);
    expect(status.over).toBe(false);
  });

  it('报告总量与上限的具体数字', () => {
    const blocks = Array.from({ length: 3 }, (_, i) => textBlock(`b${i}`));
    const status = blockBudgetStatus({ blocks });
    expect(status.total).toBe(3);
    expect(status.limit).toBe(200);
  });
});
