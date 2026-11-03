import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAGRAM_SPECS, diagramBlockHtml } from './diagramSpec';
import { decorateEditorDiagrams, findDiagramBlock, hydrateDiagrams } from './diagramHydrate';

function container(inner: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = inner;
  document.body.appendChild(host);
  return host;
}

describe('阅读页水合', () => {
  it('把 pp-diagram 围栏替换成 figure + svg，普通代码块不动', () => {
    const host = container(
      `${diagramBlockHtml(DEFAULT_DIAGRAM_SPECS.mindmap)}<pre><code class="language-js">const a = 1;</code></pre>`,
    );
    const count = hydrateDiagrams(host);
    expect(count).toBe(1);
    const figure = host.querySelector('figure.pp-diagram');
    expect(figure).not.toBeNull();
    expect(figure?.classList.contains('pp-diagram-mindmap')).toBe(true);
    expect(figure?.getAttribute('data-diagram-type')).toBe('mindmap');
    expect(figure?.querySelector('svg')).not.toBeNull();
    // 图表代码块被替换，普通代码块保留。
    expect(host.querySelector('code.language-pp-diagram')).toBeNull();
    expect(host.querySelector('code.language-js')?.textContent).toContain('const a = 1;');
    // 幂等：再水合一次没有可替换的块。
    expect(hydrateDiagrams(host)).toBe(0);
  });

  it('坏 JSON / 未知类型保留成代码块，不抛错', () => {
    const host = container(
      '<pre><code class="language-pp-diagram">{oops</code></pre><pre><code class="language-pp-diagram">{"type":"nope"}</code></pre>',
    );
    expect(hydrateDiagrams(host)).toBe(0);
    expect(host.querySelectorAll('pre')).toHaveLength(2);
  });

  it('null 根节点安全返回 0', () => {
    expect(hydrateDiagrams(null)).toBe(0);
    expect(hydrateDiagrams(document.createElement('div'))).toBe(0);
  });
});

describe('编辑器内联装饰', () => {
  it('保留隐藏 code 并插入可见预览与编辑按钮，且只装饰一次', () => {
    const host = container(diagramBlockHtml(DEFAULT_DIAGRAM_SPECS.chart));
    const pre = host.querySelector('pre');
    expect(decorateEditorDiagrams(host)).toBe(1);
    expect(pre?.classList.contains('pp-diagram-inline')).toBe(true);
    const code = pre?.querySelector('code');
    expect(code?.classList.contains('pp-diagram-source')).toBe(true);
    expect(code?.getAttribute('aria-hidden')).toBe('true');
    const preview = pre?.querySelector('.pp-diagram-preview');
    expect(preview?.getAttribute('contenteditable')).toBe('false');
    expect(preview?.querySelector('svg')).not.toBeNull();
    expect(preview?.querySelector('[data-pp-diagram-edit]')).not.toBeNull();
    // 隐藏 code 仍在 DOM 里，Markdown 序列化不会丢围栏。
    expect(code?.textContent).toContain('"type":"chart"');
    expect(decorateEditorDiagrams(host)).toBe(0);
  });
});

describe('查找光标所在图表块', () => {
  it('从 code 文本节点找到 pre 与规格', () => {
    const host = container(diagramBlockHtml(DEFAULT_DIAGRAM_SPECS.fishbone));
    const code = host.querySelector('code');
    const found = findDiagramBlock(code?.firstChild ?? null);
    expect(found?.pre).toBe(host.querySelector('pre'));
    expect(found?.spec.type).toBe('fishbone');
  });

  it('普通段落/代码块返回 null', () => {
    const host = container('<p>正文</p><pre><code class="language-js">x</code></pre>');
    expect(findDiagramBlock(host.querySelector('p')?.firstChild ?? null)).toBeNull();
    expect(findDiagramBlock(host.querySelector('code')?.firstChild ?? null)).toBeNull();
    expect(findDiagramBlock(null)).toBeNull();
  });
});
