/**
 * 行首标记的语义层：从光标所在的块元素推出它在 Markdown 里的行首写法。
 *
 * 标记必须和 `lib/htmlToMarkdown` 真正写出的语法一致（正文标题从 `##` 起，
 * 因为 `#` 留给页面标题），否则"看到的"和"存下来的"对不上。
 * 富文本区块序列化成 HTML，没有行首语法，一律不给标记。
 * 标记只是"读"功能的输入，绝不写回 DOM：它挂在 contenteditable 外面。
 */

const HEADING_PREFIX: Record<string, string> = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
};

/** 存成 HTML 的区块：没有行首语法，块内任何位置都不显示标记。 */
const HTML_BLOCK_SELECTOR = [
  'a.pp-video',
  'a.pp-embed',
  'a.pp-linkcard',
  'p.pp-image',
  'p.pp-icon-line',
  'blockquote.pp-note',
  'table',
  '[data-pp-diagram-edit]',
].join(',');

export function blockMarkerFor(block: Element | null): string | null {
  if (!block) return null;
  if (block.closest(HTML_BLOCK_SELECTOR)) return null;

  const tag = block.tagName.toLowerCase();
  const heading = HEADING_PREFIX[tag];
  if (heading) return heading;
  if (tag === 'blockquote') return '>';
  if (tag === 'pre') return '```';

  if (tag === 'li') {
    const list = block.parentElement;
    if (!list) return null;
    // 任务项在正文里就是一个 ☐/☑ 字符，没有 input，所以只能看文本开头。
    const task = (block.textContent ?? '').match(/^\s*([☐☑])/);
    if (task) return `- [${task[1] === '☑' ? 'x' : ' '}]`;
    if (list.tagName.toLowerCase() === 'ol') {
      // 序号取实际位置：列表中间插入一项后，后面的序号都要跟着变。
      const ordinal = Array.prototype.indexOf.call(list.children, block) + 1;
      return `${ordinal}.`;
    }
    return '-';
  }

  return null;
}
