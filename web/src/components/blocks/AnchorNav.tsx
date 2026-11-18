import { useEffect, useState, type ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { useT } from '../../lib/i18n';
import { useAnchorScope } from './AnchorScope';

/**
 * 本页目录（`anchor-nav`）。
 *
 * 数据来自整页的锚点分配（见 `AnchorScope`）：目录自己不认识别的区块，也**不复制**
 * 一遍「谁有锚点」的判断——页面上的 `id` 和这里列的链接出自同一趟遍历，所以不会
 * 出现「目录里有、点过去没反应」的死链。
 *
 * 三条硬规则：
 * - **点击是原生锚点跳转**：`<a href="#anchor">`，不调 `scrollIntoView`。这样 URL 可
 *   复制、可分享，浏览器前进后退照常工作，平滑滚动由 CSS 的 `scroll-behavior`
 *   负责（见 `styles.css` 的 `html` 规则）；
 * - **滚动高亮是加分项，不是前提**：`IntersectionObserver` 阈值 0.25，卸载时
 *   `disconnect()`；没有这个 API 的环境（老浏览器、服务端渲染、测试）退化为
 *   只列链接不高亮——跳转本身一点不受影响；
 * - **空状态说人话**：一条锚点都没有时给作者一句引导，而不是留一块空白。
 */

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function AnchorNav({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const { targets } = useAnchorScope();
  const heading = textOf(blockProp(block, 'heading', ''));
  /** 当前高亮的那一节；`null` 表示还没量过（或环境不支持）。 */
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    // 没有 IntersectionObserver：不高亮，但链接照旧能跳。
    if (typeof IntersectionObserver === 'undefined') return;
    const sections: HTMLElement[] = [];
    for (const target of targets) {
      const node = document.getElementById(target.anchor);
      // 锚点可能在别处被条件显示挡住了（设备 / 角色 / 时间窗）：没画出来就不观察。
      if (node) sections.push(node);
    }
    if (!sections.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting && entry.target.id);
        if (!visible.length) return;
        // 两节同时在视口里（矮屏 + 长页很常见）时取最靠上的那一节：读者正在读的是它。
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActive(visible[0].target.id);
      },
      { threshold: 0.25 },
    );
    for (const node of sections) observer.observe(node);
    return () => observer.disconnect();
  }, [targets]);

  return (
    <nav className="pp-anchor-nav" aria-label={t('本页目录')}>
      {heading ? <h2 className="pp-anchor-nav-heading">{heading}</h2> : null}
      {targets.length ? (
        <ol className="pp-anchor-nav-list">
          {targets.map((target) => (
            <li className="pp-anchor-nav-item" key={target.anchor}>
              <a
                className="pp-anchor-nav-link"
                href={`#${target.anchor}`}
                aria-current={active === target.anchor ? 'location' : undefined}
              >
                {target.title}
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pp-anchor-nav-empty">{t('给其他区块填上锚点后，这里会出现本页目录。')}</p>
      )}
    </nav>
  );
}

export const ANCHOR_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  'anchor-nav': AnchorNav,
};
