import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChangeEvent as ReactChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  UIEvent as ReactUIEvent,
} from 'react';

/**
 * 源码编辑器：`<textarea>` + 左侧行号 gutter（代码索引）。
 *
 * HTML 与 Markdown 两个源码框共用它。几条有意为之的约束：
 * - 行号渲染在 textarea **外面**，并标了 `aria-hidden` / `user-select: none`：
 *   复制源码时只会拿到 textarea 的选区，行号不会混进剪贴板。
 * - `wrap="off"`：一条逻辑行只占一个行高，行号才能和 textarea 的每一行严格对齐；
 *   否则浏览器软换行会让第 N 行之后的号码整体错位。源码本身适合横向滚动。
 * - 滚动用 transform 跟随，而不是给 gutter 设置 scrollTop：gutter 是
 *   `overflow: hidden` 的裁剪区，transform 不会被自身的最大滚动距离夹住，滚到底也不会错位。
 * - Tab / 快捷键完全由调用方的 `onKeyDown` 处理，这里不拦截任何按键。
 */

/** 从 textarea 计算样式里量出来的排版参数，单位 px。 */
export interface SourceCodeMetrics {
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
}

const FALLBACK_LINE_HEIGHT = 22;
const DEFAULT_METRICS: SourceCodeMetrics = {
  lineHeight: FALLBACK_LINE_HEIGHT,
  paddingTop: 16,
  paddingBottom: 16,
};

/**
 * 源码文本的逻辑行数。
 *
 * 空文本也算 1 行（光标总得落在某一行），末尾换行会多出一个空行——
 * 这和编辑器里看到的行号一致。
 */
export function sourceLineCount(text: string): number {
  if (!text) return 1;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** 每一行在文本里的起始偏移；返回数组长度就是行数。 */
export function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * 字符偏移所在的行号（从 1 开始）。
 *
 * 偏移落在换行符上时算作前一行的行尾；越界偏移夹到首行 / 末行。
 */
export function sourceLineAtOffset(text: string, offset: number): number {
  const starts = sourceLineStarts(text);
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** gutter 内容总高度：上下内边距 + 行数 × 行高，用来和 textarea 的滚动内容对齐。 */
export function sourceGutterHeight(
  text: string,
  lineHeight: number,
  paddingTop = 0,
  paddingBottom = 0,
): number {
  return paddingTop + paddingBottom + sourceLineCount(text) * lineHeight;
}

/** gutter 至少要放两位数字（1–9 行时不跳宽度）；位数随行数增长。 */
export function sourceGutterDigits(text: string): number {
  return Math.max(2, String(sourceLineCount(text)).length);
}

export interface SourceCodeEditorProps {
  value: string;
  onChange: (event: ReactChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** 把 textarea 暴露给父组件：快捷插入需要读 selectionStart / selectionEnd。 */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
}

export function SourceCodeEditor({
  value,
  onChange,
  onKeyDown,
  inputRef,
  disabled = false,
  placeholder,
  ariaLabel,
}: SourceCodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [metrics, setMetrics] = useState<SourceCodeMetrics>(DEFAULT_METRICS);
  const [scrollTop, setScrollTop] = useState(0);
  const [activeLine, setActiveLine] = useState(1);

  const attachRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  const syncActiveLine = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const line = sourceLineAtOffset(textarea.value, textarea.selectionStart);
    setActiveLine((previous) => (previous === line ? previous : line));
  }, []);

  // 行高与内边距从计算样式里量：行号行必须和 textarea 的每个行盒逐像素对齐。
  // 用 layout effect 是为了在首帧绘制前拿到真实值，避免行号先闪一下再挪位。
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const styles = getComputedStyle(textarea);
    const fontSize = Number.parseFloat(styles.fontSize);
    const measuredLineHeight = Number.parseFloat(styles.lineHeight);
    setMetrics({
      lineHeight:
        measuredLineHeight > 0
          ? measuredLineHeight
          : fontSize > 0
            ? fontSize * 1.75
            : FALLBACK_LINE_HEIGHT,
      paddingTop: Number.parseFloat(styles.paddingTop) || 0,
      paddingBottom: Number.parseFloat(styles.paddingBottom) || 0,
    });
  }, []);

  // textarea 的选区变化不会冒泡到 React；键盘、鼠标与程序化 setSelectionRange
  // 都用 document 的 selectionchange 兜住，且只在焦点确实在这只 textarea 上时更新。
  useEffect(() => {
    const handleSelectionChange = () => {
      if (document.activeElement === textareaRef.current) syncActiveLine();
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [syncActiveLine]);

  // 外部改写 value（快捷插入、撤销、切换模式）后光标会移动，下一帧再同步一次。
  useEffect(() => {
    const frame = requestAnimationFrame(syncActiveLine);
    return () => cancelAnimationFrame(frame);
  }, [value, syncActiveLine]);

  const lineCount = sourceLineCount(value);
  const gutterHeight = sourceGutterHeight(
    value,
    metrics.lineHeight,
    metrics.paddingTop,
    metrics.paddingBottom,
  );

  return (
    <div className="source-code-editor">
      <div
        className="source-code-gutter"
        aria-hidden="true"
        style={{ width: `calc(${sourceGutterDigits(value)}ch + 18px)` }}
      >
        <div
          className="source-code-gutter-inner"
          style={{ height: gutterHeight, transform: `translateY(${-scrollTop}px)` }}
        >
          {/* 上内边距与 textarea 的 padding-top 对齐；滚动时它跟着滚走，和 textarea 一致。 */}
          <div className="source-code-spacer" style={{ height: metrics.paddingTop }} aria-hidden="true" />
          {Array.from({ length: lineCount }, (_, index) => (
            <div
              key={index}
              className={`source-code-line${index + 1 === activeLine ? ' is-active' : ''}`}
              style={{ height: metrics.lineHeight, lineHeight: `${metrics.lineHeight}px` }}
            >
              {index + 1}
            </div>
          ))}
          <div className="source-code-spacer" style={{ height: metrics.paddingBottom }} aria-hidden="true" />
        </div>
      </div>
      <textarea
        ref={attachRef}
        className="textarea editor-source-input source-code-input"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onScroll={(event: ReactUIEvent<HTMLTextAreaElement>) =>
          setScrollTop(event.currentTarget.scrollTop)
        }
        onFocus={syncActiveLine}
        onClick={syncActiveLine}
        onKeyUp={syncActiveLine}
        onSelect={syncActiveLine}
        disabled={disabled}
        spellCheck={false}
        wrap="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
    </div>
  );
}
