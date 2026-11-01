import { describe, expect, it } from 'vitest';
import { normalizeEditorSource } from './editorSource';

describe('normalizeEditorSource', () => {
  it('keeps Markdown source as the editable Markdown value', () => {
    const result = normalizeEditorSource('markdown', '# 标题\n\n**正文**');

    expect(result.markdown).toBe('# 标题\n\n**正文**');
    expect(result.html).toContain('<h1>标题</h1>');
    expect(result.html).toContain('<strong>正文</strong>');
  });

  it('converts historical HTML to Markdown and safe editor HTML', () => {
    const result = normalizeEditorSource(
      'html',
      '<h2>标题</h2><p>正文<script>alert(1)</script></p>',
    );

    expect(result.markdown).toContain('## 标题');
    expect(result.markdown).toContain('正文');
    expect(result.markdown).not.toContain('script');
    expect(result.html).not.toContain('<script');
  });

  it('converts plain text blocks to Markdown paragraphs', () => {
    const result = normalizeEditorSource('plain', '第一段\n\n第二段');

    expect(result.markdown).toBe('第一段\n\n第二段\n');
    expect(result.html).toContain('<p>第一段</p>');
    expect(result.html).toContain('<p>第二段</p>');
  });
});
