import { describe, expect, it } from 'vitest';
import { collapseBlock, noteBlock, tipBlock, warningBlock } from './richBlocks';

/**
 * 编辑器插入的富文本区块是「存盘内容」的一部分：这里锁定工具栏 / 斜杠面板 / 源码
 * 快捷插入栏共用的 HTML 结构，避免哪天改了类名导致服务端清洗后样式全丢。
 */
describe('提示 / 警告卡片', () => {
  it('tipBlock 复用 info 色调的说明块，带标题与正文占位', () => {
    const html = tipBlock();
    expect(html).toContain('class="pp-note pp-note-info"');
    expect(html).toContain('<strong>提示</strong>');
    expect(html).toContain('要补充的说明');
  });

  it('warningBlock 复用 warn 色调的说明块，带标题与正文占位', () => {
    const html = warningBlock();
    expect(html).toContain('class="pp-note pp-note-warn"');
    expect(html).toContain('<strong>注意</strong>');
    expect(html).toContain('请读者留意这里的说明');
  });

  it('接受自定义标题与正文，并与 noteBlock 输出完全一致', () => {
    expect(tipBlock('小提示', '正文。')).toBe(noteBlock('info', '小提示', '正文。'));
    expect(warningBlock('警告', '别这么做。')).toBe(noteBlock('warn', '警告', '别这么做。'));
  });
});

describe('折叠文本', () => {
  it('输出 details.pp-collapse + summary + p 的结构', () => {
    expect(collapseBlock()).toBe(
      '<details class="pp-collapse"><summary>标题</summary><p>正文</p></details>',
    );
  });

  it('默认不带 open，公开页默认收起', () => {
    expect(collapseBlock('更多', '展开后的正文。')).not.toContain('open');
  });

  it('标题与正文先转义再拼进标签', () => {
    const html = collapseBlock('<script>alert(1)</script>', 'a & b');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });
});
