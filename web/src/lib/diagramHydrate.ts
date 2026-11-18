import type { DiagramSpec } from './diagramSpec';
import { isDiagramCode, parseDiagramJson } from './diagramSpec';
import { renderDiagramSvg } from './diagramSvg';
import { t } from './i18n';

/**
 * 图表水合：把正文里的 `pre > code.language-pp-diagram` 变成真正画出来的图。
 *
 * 两个使用面：
 * - **阅读页**（`hydrateDiagrams`）：服务端返回的 `rendered_html` 里只有围栏代码块，
 *   渲染后在这里替换成 `<figure class="pp-diagram">` + SVG；
 * - **编辑器**（`decorateEditorDiagrams`）：保留隐藏的 `code`（`htmlToMarkdown` 靠它
 *   还原围栏），同时插一块不可编辑的预览，让作者在正文里直接看到图。
 *
 * 幂等：已经水合/装饰过的块不会重复处理；坏 JSON 原样保留成代码块，
 * 作者至少能看到原始内容并手动修改，不会整块消失。
 */

/** 生成阅读页的图表容器；SVG 由纯函数渲染，标签已转义。 */
export function diagramFigure(spec: DiagramSpec): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = `pp-diagram pp-diagram-${spec.type}`;
  figure.dataset.diagramType = spec.type;
  if (spec.title) figure.setAttribute('aria-label', spec.title);
  figure.innerHTML = renderDiagramSvg(spec);
  return figure;
}

/** 阅读页：把正文里的图表代码块替换成 SVG。返回替换的块数。 */
export function hydrateDiagrams(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let hydrated = 0;
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (!pre.isConnected) continue;
    const code = pre.querySelector('code');
    if (!isDiagramCode(code)) continue;
    const spec = parseDiagramJson(code.textContent ?? '');
    if (!spec) continue;
    pre.replaceWith(diagramFigure(spec));
    hydrated += 1;
  }
  return hydrated;
}

/**
 * 编辑器：给图表代码块加一块可见预览。
 *
 * 结构变成 `pre.pp-diagram-inline > (span.pp-diagram-preview + code.pp-diagram-source)`；
 * `code` 由 CSS 隐藏但仍留在 DOM 里，`htmlToMarkdown` 只读它，围栏不会丢。
 */
export function decorateEditorDiagrams(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let decorated = 0;
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.classList.contains('pp-diagram-inline')) continue;
    const code = pre.querySelector('code');
    if (!isDiagramCode(code)) continue;
    const spec = parseDiagramJson(code.textContent ?? '');
    if (!spec) continue;

    const preview = document.createElement('span');
    preview.className = 'pp-diagram-preview';
    preview.contentEditable = 'false';
    preview.dataset.ppDiagramPreview = '1';
    preview.innerHTML = renderDiagramSvg(spec);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'pp-diagram-edit';
    edit.contentEditable = 'false';
    edit.dataset.ppDiagramEdit = '1';
    edit.textContent = t('编辑图表');
    preview.appendChild(edit);

    code.classList.add('pp-diagram-source');
    code.setAttribute('aria-hidden', 'true');
    pre.classList.add('pp-diagram-inline');
    pre.insertBefore(preview, code);
    decorated += 1;
  }
  return decorated;
}

/** 从光标/选区所在的节点找到图表代码块，供「编辑图表」回填。 */
export function findDiagramBlock(
  node: Node | null,
): { pre: HTMLElement; spec: DiagramSpec } | null {
  if (!node) return null;
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const pre = start?.closest('pre') ?? null;
  if (!pre) return null;
  const code = pre.querySelector('code');
  if (!isDiagramCode(code)) return null;
  const spec = parseDiagramJson(code.textContent ?? '');
  return spec ? { pre, spec } : null;
}
