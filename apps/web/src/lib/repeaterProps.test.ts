import { describe, expect, it } from 'vitest';
import { BLOCK_DEFS, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

describe('normalizeBlockProps', () => {
  it('repeater 值按 itemSchema 递归清洗，未声明的键被丢弃', () => {
    const props = normalizeBlockProps('button', {
      buttons: [{ label: '去', link: '/a', style: 'solid', __evil: '<script>' }],
      unknown_top: 'drop me',
    });
    expect(props.buttons).toEqual([{ label: '去', link: '/a', style: 'solid' }]);
    expect(props.unknown_top).toBeUndefined();
  });

  it('repeater 超出 maxItems 的部分被截掉', () => {
    const buttons = Array.from({ length: 9 }, (_, i) => ({ label: `b${i}`, link: '/' }));
    const props = normalizeBlockProps('button', { buttons });
    expect((props.buttons as unknown[]).length).toBe(4);
  });

  it('非数组的 repeater 值被丢弃', () => {
    const props = normalizeBlockProps('button', { buttons: 'not-an-array' });
    expect(props.buttons).toBeUndefined();
  });

  it('旧配置里的 itemlist JSON 字符串仍然能读成 repeater 值', () => {
    const props = normalizeBlockProps('button', {
      buttons: JSON.stringify([{ label: '旧按钮', link: '/old' }]),
    });
    expect(props.buttons).toEqual([{ label: '旧按钮', link: '/old', style: '' }]);
  });

  it('不认识类型的 props 原样保留标量', () => {
    expect(normalizeBlockProps('pricing-v9', { plan: 'A', n: 1 })).toEqual({ plan: 'A', n: 1 });
  });

  // 「显示什么数据」的绑定存在 props['bind:<字段>']，它不是 schema 字段；
  // 白名单清洗如果把它一起丢掉，用户保存一次就永久失去绑定。
  it('保留 bind: 开头的绑定键，丢掉其余未声明键', () => {
    const props = normalizeBlockProps('classic-hero', {
      title: '手写标题',
      'bind:title': 'article.title',
      'bind:__proto__': 'article.url',
      unknown_top: 'drop me',
    });
    expect(props['bind:title']).toBe('article.title');
    expect(props['bind:__proto__']).toBeUndefined();
    expect(props.unknown_top).toBeUndefined();
  });
});

describe('createBlock', () => {
  it('button 的默认 props 是空 repeater 而不是 JSON 字符串', () => {
    expect(createBlock('button').props.buttons).toEqual([]);
  });
});

describe('schema 与 defaults 一致', () => {
  it('每个区块的 defaults 键都声明在 schema 里（否则保存一次就会丢内容）', () => {
    const missing: string[] = [];
    for (const def of BLOCK_DEFS) {
      const declared = new Set(def.schema.map((field) => field.key));
      for (const key of Object.keys(def.defaults)) {
        if (!declared.has(key)) missing.push(`${def.type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('每个区块的默认 props 经过归一化后原样保留（读→写幂等）', () => {
    const drifted: string[] = [];
    for (const def of BLOCK_DEFS) {
      const created = createBlock(def.type);
      const normalized = normalizeBlockProps(def.type, created.props);
      const before = JSON.stringify(created.props);
      const after = JSON.stringify(normalized);
      if (before !== after) drifted.push(`${def.type}: ${before} -> ${after}`);
    }
    expect(drifted).toEqual([]);
  });
});
