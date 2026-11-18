import { describe, expect, it } from 'vitest';
import { DEFAULT_CUSTOMIZATION, readCustomization } from './customize';

/**
 * 首页编排的「空」与「没配过」必须区分。
 *
 * 旧读取逻辑 `home.blocks.length ? home : defaultHomeLayout()` 会把作者显式清空的首页
 * 当成从未配置：在编排台里删光区块、保存，下一次读取又长回默认区块，看起来就像
 * 「真正的编排内容改不动」。这里钉住两件事：
 * - 从没写过 home 的旧配置仍然拿到默认编排（空站点不能变白板）；
 * - 明确保存过 `home.blocks`（哪怕为空数组）就原样尊重。
 */
describe('首页编排：显式空 vs 未配置', () => {
  it('从未配置过首页时回退默认编排', () => {
    const customization = readCustomization({ customization: {} } as never);
    expect(customization.home.blocks.length).toBeGreaterThan(0);
    expect(DEFAULT_CUSTOMIZATION.home.blocks.length).toBeGreaterThan(0);
  });

  it('home 只有别的字段、没有 blocks 时仍回退默认编排', () => {
    const customization = readCustomization({
      customization: { home: { note: 'legacy' } },
    } as never);
    expect(customization.home.blocks.length).toBeGreaterThan(0);
  });

  it('显式保存的空首页保持为空', () => {
    const customization = readCustomization({
      customization: { home: { blocks: [] } },
    } as never);
    expect(customization.home.blocks).toEqual([]);
  });

  it('空首页 + 白昼版式也保持为空（不能被默认头版顶掉）', () => {
    const customization = readCustomization({
      customization: { layout: { variant: 'daylight' }, home: { blocks: [] } },
    } as never);
    expect(customization.home.blocks).toEqual([]);
  });

  it('正常编排原样保留', () => {
    const customization = readCustomization({
      customization: {
        home: {
          blocks: [
            {
              id: 'blk_1',
              type: 'text',
              title: '正文',
              props: { body: 'hello' },
              animation: 'none',
              hidden: false,
            },
          ],
        },
      },
    } as never);
    expect(customization.home.blocks.map((block) => block.id)).toEqual(['blk_1']);
  });
});
