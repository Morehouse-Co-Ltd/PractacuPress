import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { copyText } from '../lib/clipboard';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/** 给正文标题分配锚点，并返回目录。只在文章页调用。 */
export function useArticleToc(html: string | undefined): TocItem[] {
  const [items, setItems] = useState<TocItem[]>([]);

  useEffect(() => {
    const root = document.querySelector('.article-body');
    if (!root) {
      setItems([]);
      return;
    }
    const heads = Array.from(root.querySelectorAll('h2, h3')) as HTMLElement[];
    const used = new Set<string>();
    const next = heads
      .map((el, index) => {
        const text = (el.textContent ?? '').trim();
        if (!text) return null;
        let id = el.id;
        if (!id) {
          id = `section-${index + 1}`;
          let suffix = index + 1;
          while (used.has(id) || document.getElementById(id)) {
            suffix += 1;
            id = `section-${suffix}`;
          }
          el.id = id;
        }
        used.add(id);
        el.style.scrollMarginTop = '96px';
        return { id, text, level: el.tagName === 'H2' ? 2 : 3 };
      })
      .filter((item): item is TocItem => item !== null);
    setItems(next);
  }, [html]);

  return items;
}

export function ArticleToc({ items }: { items: TocItem[] }) {
  if (items.length < 2) return null;
  return (
    <nav className="article-toc" aria-label="本文目录">
      <p className="article-toc-label">本文目录</p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`} className={item.level === 3 ? 'is-sub' : undefined}>
              {item.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 640);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!shown) return null;
  return (
    <button
      type="button"
      className="back-top"
      aria-label="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <Icon name="arrow-up" size={16} />
    </button>
  );
}

/** 给正文里的每个代码块加复制按钮；关闭扩展时把按钮清掉。 */
export function useCodeCopy(enabled: boolean, html: string | undefined) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.querySelector('.article-body');
    if (!root) return;
    const cleanups: (() => void)[] = [];

    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      if (pre.querySelector('.code-copy')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = '复制';
      let timer = 0;
      const onClick = async () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        button.textContent = (await copyText(code)) ? '已复制' : '复制失败';
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          button.textContent = '复制';
        }, 1600);
      };
      button.addEventListener('click', onClick);
      pre.appendChild(button);
      cleanups.push(() => {
        window.clearTimeout(timer);
        button.removeEventListener('click', onClick);
        button.remove();
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, [enabled, html]);
}
