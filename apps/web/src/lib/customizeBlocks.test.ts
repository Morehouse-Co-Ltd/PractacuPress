import { describe, expect, it } from 'vitest';
import { PROPS_MAX_BYTES, blockBudgetStatus, normalizeScreenLayout } from './customize';

function textBlock(id: string) {
  return { id, type: 'text', title: id, props: { body: 'hi' }, animation: 'none' as const, hidden: false };
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
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

  it('读入时不按产品上限截断：260 个区块原样留下，交给保存前的预算检查挡', () => {
    // 以前读的时候就裁到 200，用户会静默丢掉 60 个区块，而且编辑器永远看不到「超限」。
    const blocks = Array.from({ length: 260 }, (_, i) => textBlock(`b${i}`));
    const layout = normalizeScreenLayout({ blocks });
    expect(layout.blocks).toHaveLength(260);
    const status = blockBudgetStatus(layout);
    expect(status.over).toBe(true);
    expect(status.total).toBe(260);
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

  it('不认识类型的大字符串 props 也受单块体积预算约束', () => {
    // 未知类型的早退分支以前自建 props，绕过了 capPropBytes；超大字符串能整条走私进来。
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'x1', type: 'pricing-v9', title: '价格', props: { blob: 'x'.repeat(20_000) } }],
    });
    const block = layout.blocks[0];
    const blob = block.props.blob;
    expect(blob === undefined || (typeof blob === 'string' && blob.length < 20_000)).toBe(true);
    expect(bytesOf(block)).toBeLessThan(PROPS_MAX_BYTES + 1024);
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
