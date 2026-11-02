import { describe, expect, it } from 'vitest';
import { toExportMarkdown } from './markdownExport';

describe('toExportMarkdown', () => {
  it('turns soft line breaks inside a paragraph into hard breaks', () => {
    expect(toExportMarkdown('第一行\n第二行\n\n下一段\n')).toBe('第一行  \n第二行\n\n下一段\n');
  });

  it('leaves fenced code alone', () => {
    const source = '```ts\nconst a = 1;\nconst b = 2;\n```\n';
    expect(toExportMarkdown(source)).toBe(source);
  });

  it('leaves lists, headings, tables and html blocks alone', () => {
    const source =
      '# 标题\n\n- 一\n- 二\n\n| a | b |\n| --- | --- |\n\n<a class="pp-video" href="https://example.com">x</a>\n';
    expect(toExportMarkdown(source)).toBe(source);
  });

  it('does not break a paragraph that follows a list item', () => {
    expect(toExportMarkdown('- 一\n正文\n')).toBe('- 一\n正文\n');
  });

  it('trims stray trailing spaces outside paragraphs', () => {
    expect(toExportMarkdown('# 标题   \n\n正文   \n')).toBe('# 标题\n\n正文\n');
  });

  it('returns an empty string for blank input', () => {
    expect(toExportMarkdown('  \n\n')).toBe('');
  });
});
