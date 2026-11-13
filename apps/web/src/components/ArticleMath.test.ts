import { describe, expect, it } from 'vitest';
import { hydrateArticleMath, looksLikeFormula } from './ArticleMath';

describe('公式识别', () => {
  it('识别常见 LaTeX 片段，不把价格当公式', () => {
    expect(looksLikeFormula('v = s/t')).toBe(true);
    expect(looksLikeFormula('x^2 + y^2')).toBe(true);
    expect(looksLikeFormula('\\frac{a}{b}')).toBe(true);
    expect(looksLikeFormula('5 and ')).toBe(false);
    expect(looksLikeFormula('普通文字')).toBe(false);
  });
});

describe('hydrateArticleMath', () => {
  it('把 data-pp-math 占位节点与 $...$ 文本都水合成 KaTeX', async () => {
    document.body.innerHTML = `
      <div class="article-body" id="math-root">
        <p>速度是 $v = s/t$。</p>
        <p class="pp-math-block" data-pp-math="x^2 + y^2 = z^2">x^2 + y^2 = z^2</p>
      </div>
    `;
    const root = document.getElementById('math-root') as HTMLElement;

    await expect(hydrateArticleMath(root)).resolves.toBe(true);
    expect(root.querySelector('.pp-math-inline .katex')).toBeTruthy();
    expect(root.querySelector('.pp-math-block .katex')).toBeTruthy();
    expect(root.querySelector('.pp-math-block')?.getAttribute('title')).toBe('x^2 + y^2 = z^2');
  });

  it('没有公式时不加载引擎、不改动正文', async () => {
    document.body.innerHTML = '<div class="article-body" id="plain-root"><p>只是文字。</p></div>';
    const root = document.getElementById('plain-root') as HTMLElement;

    await expect(hydrateArticleMath(root)).resolves.toBe(false);
    expect(root.querySelector('.katex')).toBeNull();
    expect(root.textContent).toBe('只是文字。');
  });

  it('跳过代码块里的美元符号', async () => {
    document.body.innerHTML =
      '<div class="article-body" id="code-root"><pre><code>$x^2$</code></pre></div>';
    const root = document.getElementById('code-root') as HTMLElement;

    await expect(hydrateArticleMath(root)).resolves.toBe(false);
    expect(root.querySelector('.katex')).toBeNull();
  });
});
