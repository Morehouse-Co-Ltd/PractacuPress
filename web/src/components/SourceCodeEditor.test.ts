import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  SourceCodeEditor,
  sourceGutterDigits,
  sourceGutterHeight,
  sourceLineAtOffset,
  sourceLineCount,
  sourceLineStarts,
} from './SourceCodeEditor';

// React 19 的 act() 需要这个全局开关，否则测试里渲染组件会被警告「不在 act 环境」。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 行号计算是编辑器「代码索引」里唯一值得单测的部分：DOM 量测与滚动同步靠浏览器，
 * 但「有几行」「光标在第几行」「gutter 内容多高」必须可预期。
 */
describe('源码行号计算', () => {
  it('空文本也是一行', () => {
    expect(sourceLineCount('')).toBe(1);
    expect(sourceLineStarts('')).toEqual([0]);
  });

  it('按换行符数行；末尾换行多出一个空行', () => {
    expect(sourceLineCount('a')).toBe(1);
    expect(sourceLineCount('a\nb')).toBe(2);
    expect(sourceLineCount('a\nb\n')).toBe(3);
    expect(sourceLineStarts('a\nb\n')).toEqual([0, 2, 4]);
  });

  it('字符偏移换算成行号（1 起）', () => {
    const text = 'abc\ndef\nghi';
    expect(sourceLineAtOffset(text, 0)).toBe(1);
    expect(sourceLineAtOffset(text, 3)).toBe(1); // 换行符本身算第一行行尾
    expect(sourceLineAtOffset(text, 4)).toBe(2);
    expect(sourceLineAtOffset(text, 8)).toBe(3);
  });

  it('越界偏移夹到首行 / 末行', () => {
    expect(sourceLineAtOffset('a\nb', -5)).toBe(1);
    expect(sourceLineAtOffset('a\nb', 999)).toBe(2);
  });

  it('gutter 高度 = 上下内边距 + 行数 × 行高', () => {
    expect(sourceGutterHeight('', 20, 8, 8)).toBe(36);
    expect(sourceGutterHeight('a\nb\nc', 20, 8, 8)).toBe(76);
  });

  it('行号至少两位宽，随行数增长', () => {
    expect(sourceGutterDigits('a\nb')).toBe(2);
    expect(sourceGutterDigits(Array.from({ length: 120 }, () => 'x').join('\n'))).toBe(3);
  });
});

describe('SourceCodeEditor 行号渲染', () => {
  it('行号随输入值更新，gutter 不进无障碍树、textarea 禁用软换行', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = (value: string) => {
      act(() => {
        root.render(
          createElement(SourceCodeEditor, {
            value,
            onChange: () => {},
            ariaLabel: 'HTML',
          }),
        );
      });
    };

    render('a\nb');
    const gutter = container.querySelector('.source-code-gutter');
    expect(gutter?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.source-code-line')).toHaveLength(2);
    expect(container.querySelector('textarea')?.getAttribute('wrap')).toBe('off');

    render('a\nb\nc\n');
    const lines = container.querySelectorAll('.source-code-line');
    expect(lines).toHaveLength(4);
    expect(lines[3]?.textContent).toBe('4');

    act(() => root.unmount());
    container.remove();
  });
});

