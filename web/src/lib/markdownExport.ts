/**
 * 导出用的 Markdown 收尾。
 *
 * 存盘的正文是"一段一行"的写法：段落内部的软换行（Shift+Enter）只占一个换行符，
 * Markdown 渲染时会被连排——这正是"写作时不用手动断行"的前提。导出的 `.md` 是拿去
 * 别的编辑器看的，所以这里把**连续正文行之间**的软换行补成硬换行（行尾两个空格）。
 *
 * 刻意不碰围栏代码、表格、列表、标题、引用与 HTML 区块：这些地方的行结构本身有语义，
 * 补两个空格会把内容改坏（例如代码块里多出尾随空格）。
 */

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;
const TASK_ITEM = /^\s{0,3}\[[ xX]\]\s/;
const TABLE_ROW = /^\s{0,3}\|/;
const HTML_LINE = /^\s{0,3}</;
const QUOTE = /^\s{0,3}>/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** 这一行是不是"普通正文"：只有正文行之间才补硬换行。 */
function isParagraphLine(line: string): boolean {
  if (!line.trim()) return false;
  return (
    !FENCE.test(line) &&
    !HEADING.test(line) &&
    !LIST_ITEM.test(line) &&
    !TASK_ITEM.test(line) &&
    !TABLE_ROW.test(line) &&
    !HTML_LINE.test(line) &&
    !QUOTE.test(line) &&
    !RULE.test(line)
  );
}

const HARD_BREAK = '  ';

/** 把正文里的软换行补成 Markdown 硬换行；其余行只清掉多余的行尾空白。 */
export function toExportMarkdown(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.trim()) return '';

  const out: string[] = [];
  let fenceMarker: string | null = null;
  let previousIsParagraph = false;

  for (const raw of text.split('\n')) {
    const fence = raw.match(FENCE);

    if (fenceMarker) {
      // 围栏内部一字不动，只等闭合标记。
      out.push(raw);
      if (fence && fence[1] === fenceMarker) fenceMarker = null;
      previousIsParagraph = false;
      continue;
    }

    if (fence) {
      fenceMarker = fence[1];
      out.push(raw.replace(/\s+$/, ''));
      previousIsParagraph = false;
      continue;
    }

    if (isParagraphLine(raw)) {
      // 上一行也是正文才断行：段首、段尾都不该带尾随空格。
      if (previousIsParagraph) out[out.length - 1] += HARD_BREAK;
      out.push(raw.replace(/[ \t]+$/, ''));
      previousIsParagraph = true;
      continue;
    }

    out.push(raw.replace(/[ \t]+$/, ''));
    previousIsParagraph = false;
  }

  while (out.length && !out[out.length - 1].trim()) out.pop();
  return `${out.join('\n')}\n`;
}
