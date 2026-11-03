import { describe, expect, it } from 'vitest';
import { BLOCK_DEFS, blockDef } from './blocks';
import { PROPS_MAX_BYTES, normalizeBlockProps } from './customize';

/**
 * `richtext` 属性类型：值就是一段 Markdown 文本。
 *
 * 「图文交替」这类区块的正文需要段落级富文本，而 Markdown 渲染链路（`lib/markdown.ts`
 * 的 renderMarkdown + sanitizeHtml）已经在 `text` 区块上跑通了。这个类型只是把它
 * 变成注册表里的一种字段：存储仍然是 Markdown 字符串，渲染前才清洗。
 *
 * 断言的是「归一化的形状」，因为归一化是读入的唯一入口：值在这里被改坏，用户
 * 刷新一次就丢内容。
 */

/** 单块 props 在 JSON 里的实际字节数：`capPropBytes` 的判据就是这个。 */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

describe('richtext 属性', () => {
  it('作为 Markdown 字符串保存，超长被截断', () => {
    const long = `# 标题\n\n${'段落。'.repeat(3000)}`;
    const props = normalizeBlockProps('text', { body: long });
    expect(typeof props.body).toBe('string');
    expect((props.body as string).length).toBeLessThanOrEqual(8000);
  });

  it('截断后整条留在 props 里，不会被单块体积预算丢掉', () => {
    // 只截断不保证留得下：超长的值会被 capPropBytes 整条丢弃，那比截断更糟。
    const long = `# 标题\n\n${'段落。'.repeat(3000)}`;
    const props = normalizeBlockProps('text', { body: long });
    expect(props.body).toBeTruthy();
    expect(jsonBytes(props)).toBeLessThanOrEqual(PROPS_MAX_BYTES);
  });

  it('原样保留 Markdown 原文，不在归一化时渲染或清洗', () => {
    const markdown = '## 小标题\n\n- 一\n- 二\n\n**粗体** 与 [链接](/a)';
    const props = normalizeBlockProps('text', { body: markdown });
    expect(props.body).toBe(markdown);
  });

  it('非字符串被丢弃', () => {
    expect(normalizeBlockProps('text', { body: 42 }).body).toBeUndefined();
    expect(normalizeBlockProps('text', { body: null }).body).toBeUndefined();
    expect(normalizeBlockProps('text', { body: ['# 标题'] }).body).toBeUndefined();
  });

  it('空串保留：新建区块的默认状态，读一次不能少一个键', () => {
    expect(normalizeBlockProps('text', { body: '' }).body).toBe('');
  });

  it('至少有一个区块声明了 richtext 属性', () => {
    const types = BLOCK_DEFS.flatMap((def) => def.schema.map((field) => field.type));
    expect(types).toContain('richtext');
  });

  it('text 区块的正文就是 richtext', () => {
    // P2 的图文交替区块（Task 4）之前，让 text 顺手升级，这个类型就立刻有真实消费者。
    const body = blockDef('text')?.schema.find((field) => field.key === 'body');
    expect(body?.type).toBe('richtext');
  });
});
