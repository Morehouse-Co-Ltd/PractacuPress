import { describe, expect, it } from 'vitest';
import {
  detectBlockPrefix,
  detectInlineClosure,
  looksLikeMarkdown,
} from './markdownInput';

describe('detectBlockPrefix', () => {
  it('maps Markdown headings onto the editor heading levels', () => {
    expect(detectBlockPrefix('# ')).toEqual({ kind: 'h2', rest: '' });
    expect(detectBlockPrefix('## ')).toEqual({ kind: 'h3', rest: '' });
    expect(detectBlockPrefix('### ')).toEqual({ kind: 'h4', rest: '' });
    expect(detectBlockPrefix('#### ')).toEqual({ kind: 'h4', rest: '' });
    expect(detectBlockPrefix('# 标题')).toEqual({ kind: 'h2', rest: '标题' });
  });

  it('requires a space after heading markers', () => {
    expect(detectBlockPrefix('#标题')).toBeNull();
    expect(detectBlockPrefix('##### 太深了')).toBeNull();
  });

  it('recognizes lists, quotes and task items', () => {
    expect(detectBlockPrefix('- ')).toEqual({ kind: 'ul', rest: '' });
    expect(detectBlockPrefix('* ')).toEqual({ kind: 'ul', rest: '' });
    expect(detectBlockPrefix('- 条目')).toEqual({ kind: 'ul', rest: '条目' });
    expect(detectBlockPrefix('1. ')).toEqual({ kind: 'ol', rest: '' });
    expect(detectBlockPrefix('12. 第十二条')).toEqual({ kind: 'ol', rest: '第十二条' });
    expect(detectBlockPrefix('> ')).toEqual({ kind: 'quote', rest: '' });
    expect(detectBlockPrefix('> 引用')).toEqual({ kind: 'quote', rest: '引用' });
    expect(detectBlockPrefix('[ ] ')).toEqual({ kind: 'task', rest: '' });
    expect(detectBlockPrefix('[] ')).toEqual({ kind: 'task', rest: '' });
    expect(detectBlockPrefix('- [ ] 待办')).toEqual({ kind: 'task', rest: '待办' });
  });

  it('requires a space after list markers', () => {
    expect(detectBlockPrefix('-x')).toBeNull();
    expect(detectBlockPrefix('1.x')).toBeNull();
    expect(detectBlockPrefix('>x')).toBeNull();
    expect(detectBlockPrefix('[ ]x')).toBeNull();
  });

  it('recognizes horizontal rules and code fences', () => {
    expect(detectBlockPrefix('---')).toEqual({ kind: 'hr', rest: '' });
    expect(detectBlockPrefix('---  ')).toEqual({ kind: 'hr', rest: '' });
    expect(detectBlockPrefix('```')).toEqual({ kind: 'code', rest: '' });
    expect(detectBlockPrefix('```ts')).toEqual({ kind: 'code', rest: '' });
  });

  it('does not treat prefixes in the middle of a line as block syntax', () => {
    expect(detectBlockPrefix('正文 - ')).toBeNull();
    expect(detectBlockPrefix('  # ')).toBeNull();
    expect(detectBlockPrefix('--- 之后还有字')).toBeNull();
    expect(detectBlockPrefix('')).toBeNull();
  });
});

describe('detectInlineClosure', () => {
  it('recognizes bold, italic, code and strike closures', () => {
    expect(detectInlineClosure('**粗体**')).toEqual({
      kind: 'bold',
      inner: '粗体',
      raw: '**粗体**',
    });
    expect(detectInlineClosure('前面 *斜体*')).toEqual({
      kind: 'italic',
      inner: '斜体',
      raw: '*斜体*',
    });
    expect(detectInlineClosure('`代码`')).toEqual({
      kind: 'code',
      inner: '代码',
      raw: '`代码`',
    });
    expect(detectInlineClosure('~~删除~~')).toEqual({
      kind: 'strike',
      inner: '删除',
      raw: '~~删除~~',
    });
  });

  it('recognizes http(s) links and rejects other protocols', () => {
    expect(detectInlineClosure('[示例](https://example.com/a?b=1)')).toEqual({
      kind: 'link',
      inner: '示例',
      href: 'https://example.com/a?b=1',
      raw: '[示例](https://example.com/a?b=1)',
    });
    expect(detectInlineClosure('[示例](http://example.com)')?.href).toBe(
      'http://example.com',
    );
    expect(detectInlineClosure('[示例](javascript:alert(1))')).toBeNull();
    expect(detectInlineClosure('[示例](ftp://example.com)')).toBeNull();
  });

  it('does not mistake bold markers for italic ones', () => {
    expect(detectInlineClosure('**重点**')?.kind).toBe('bold');
    expect(detectInlineClosure('**重点**')?.inner).toBe('重点');
  });

  it('ignores unfinished or escaped syntax', () => {
    expect(detectInlineClosure('**未闭合')).toBeNull();
    expect(detectInlineClosure('普通文字')).toBeNull();
    expect(detectInlineClosure('\\*转义\\*')).toBeNull();
    expect(detectInlineClosure('')).toBeNull();
  });
});

describe('looksLikeMarkdown', () => {
  it('accepts common Markdown structures', () => {
    expect(looksLikeMarkdown('# 标题')).toBe(true);
    expect(looksLikeMarkdown('- 列表\n- 第二项')).toBe(true);
    expect(looksLikeMarkdown('1. 第一步')).toBe(true);
    expect(looksLikeMarkdown('> 引用')).toBe(true);
    expect(looksLikeMarkdown('```js\nconst a = 1;\n```')).toBe(true);
    expect(looksLikeMarkdown('[ ] 待办')).toBe(true);
    expect(looksLikeMarkdown('| 列 | 列 |\n| --- | --- |\n| a | b |')).toBe(true);
    expect(looksLikeMarkdown('看这个 [链接](https://example.com)')).toBe(true);
    expect(looksLikeMarkdown('这是 **粗体** 文字')).toBe(true);
    expect(looksLikeMarkdown('这是 *斜体* 文字')).toBe(true);
    expect(looksLikeMarkdown('这是 `代码` 文字')).toBe(true);
    expect(looksLikeMarkdown('---')).toBe(true);
  });

  it('rejects plain prose, bare URLs and asterisk multiplication', () => {
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown('一段普通的中文文字。')).toBe(false);
    expect(looksLikeMarkdown('多行文字\n没有 Markdown 结构')).toBe(false);
    expect(looksLikeMarkdown('https://example.com/plain')).toBe(false);
    expect(looksLikeMarkdown('3 * 4 = 12，a * b * c')).toBe(false);
    expect(looksLikeMarkdown('文件名_带下划线')).toBe(false);
  });
});
