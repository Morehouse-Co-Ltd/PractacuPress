import { afterEach, describe, expect, it } from 'vitest';
import { availableBlocks, blockDef, createBlock, defaultArea, isKnownBlockType } from './blocks';
import { pluginBlockRegistry } from './plugins/registry';
import type { Disposable } from './plugins/types';

/**
 * 主题组件的编排器适配。
 *
 * 这些断言盯的是「主题包能带组件」这件事真正落地的那一层：组件注册后必须出现在
 * 对应版式的组件库、默认属性来自清单、双栏落位来自清单、读取旧编排时不算坏数据。
 * 元数据只从 manifest 来，bundle 自己的说法不参与。
 */
describe('主题组件的页面编排适配', () => {
  let disposable: Disposable | undefined;

  afterEach(() => {
    disposable?.();
    disposable = undefined;
  });

  function registerHero(variants: ('classic' | 'bento' | 'daylight')[] = ['classic']) {
    disposable = pluginBlockRegistry.register(
      'aurora.hero',
      'com.acme.aurora',
      () => null,
      {
        type: 'aurora.hero',
        name: '极光开屏',
        description: '大标题、副标题与两个按钮。',
        group: 'shared',
        variants,
        area: 'full',
        defaults: { heading: 'Aurora', sub: '极光下的长文。' },
        schema: [
          { key: 'heading', label: '主标题', type: 'text' },
          { key: 'sub', label: '副标题', type: 'text' },
        ],
      },
    );
  }

  it('注册后出现在对应版式的组件库，并带上清单里的名字与说明', () => {
    registerHero(['classic']);
    const found = availableBlocks('classic').find((def) => def.type === 'aurora.hero');
    expect(found?.name).toBe('极光开屏');
    expect(found?.description).toContain('大标题');
    expect(availableBlocks('bento').some((def) => def.type === 'aurora.hero')).toBe(false);
  });

  it('新建区块使用清单里的 defaults 与 area', () => {
    registerHero();
    const block = createBlock('aurora.hero');
    expect(block.props.heading).toBe('Aurora');
    expect(block.title).toBe('极光开屏');
    expect(defaultArea('aurora.hero')).toBe('full');
    expect(blockDef('aurora.hero')?.schema.map((field) => field.key)).toEqual(['heading', 'sub']);
  });

  it('读取站点设计时主题组件算已知类型，卸载后回到未知但不丢数据', () => {
    registerHero();
    expect(isKnownBlockType('aurora.hero')).toBe(true);
    disposable?.();
    disposable = undefined;
    expect(isKnownBlockType('aurora.hero')).toBe(false);
    // 数据侧仍然保留定义查询能力之外的原始 JSON；这里只钉住「未知」这条判定，
    // normalizeScreenLayout 的保留逻辑由 customize.test.ts 覆盖。
    expect(blockDef('aurora.hero')).toBeUndefined();
  });
});
