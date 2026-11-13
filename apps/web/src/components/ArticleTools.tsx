import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { copyText } from '../lib/clipboard';
import { hydrateDiagrams } from '../lib/diagramHydrate';
import { useT } from '../lib/i18n';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/**
 * 当前文章的正文容器。
 *
 * 编排里的文本组件正文也带 `.article-body`（见 MediaBlocks），所以优先用「文章内容」
 * 区块打的 `[data-pp-article-body]` 标记；没有标记时（旧渲染路径）仍取第一个
 * `.article-body`，行为与以前一致。
 */
function articleBodyRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-pp-article-body]') ??
    document.querySelector<HTMLElement>('.article-body')
  );
}

/** 给正文标题分配锚点，并返回目录。只在文章页调用。 */
export function useArticleToc(html: string | undefined): TocItem[] {
  const [items, setItems] = useState<TocItem[]>([]);

  useEffect(() => {
    const root = articleBodyRoot();
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

export function ArticleToc({ items, className = '' }: { items: TocItem[]; className?: string }) {
  const t = useT();
  if (items.length < 2) return null;
  return (
    <nav className={`article-toc${className ? ` ${className}` : ''}`} aria-label={t('本文目录')}>
      <p className="article-toc-label">{t('本文目录')}</p>
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

/**
 * 当前读到的标题。
 *
 * 只按「标题顶端已经越过页头」判断，不依赖 IntersectionObserver 的可见比例：
 * 长标题和短标题混排时，比例法会把一个大标题误判成还没进入阅读区。
 */
function useActiveHeading(items: TocItem[]): string {
  const [active, setActive] = useState('');

  useEffect(() => {
    if (!items.length) {
      setActive('');
      return;
    }
    let ticking = false;
    const update = () => {
      ticking = false;
      const threshold = 148;
      let current = items[0]?.id ?? '';
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= threshold) current = item.id;
        else break;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [items]);

  return active;
}

/**
 * 桌面端左侧的悬浮目录。
 *
 * 白昼被合并进夜航后，文章页改成「中央阅读列 + 左侧悬浮目录」：目录固定在
 * 阅读列左侧的空白里，不占正文宽度，也不再把正文挤到屏幕偏右。窄屏隐藏，
 * 由正文上方的折叠目录接管。
 */
export function FloatingToc({ items }: { items: TocItem[] }) {
  const t = useT();
  const active = useActiveHeading(items);
  if (items.length < 2) return null;
  return (
    <aside className="article-float-toc" aria-label={t('本文目录')}>
      <p className="article-float-toc-label">{t('本文目录')}</p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={`${item.level === 3 ? 'is-sub' : ''}${active === item.id ? ' is-active' : ''}`.trim()}
              aria-current={active === item.id ? 'location' : undefined}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function BackToTop() {
  const t = useT();
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
      aria-label={t('回到顶部')}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <Icon name="arrow-up" size={16} />
    </button>
  );
}

/**
 * 把正文里的 `pp-diagram` 围栏水合成 SVG 图表。
 *
 * 与 `useCodeCopy` 一样只在文章页调用：服务端只返回白名单内的 `pre > code`，
 * 图表由前端按当前主题画出来，因此不需要放宽安全清洗规则。
 */
export function useArticleDiagrams(html: string | undefined) {
  useEffect(() => {
    const root = articleBodyRoot();
    if (!root) return;
    hydrateDiagrams(root);
  }, [html]);
}

/** 给正文里的每个代码块加复制按钮；关闭扩展时把按钮清掉。 */
export function useCodeCopy(enabled: boolean, html: string | undefined) {  const t = useT();
  useEffect(() => {
    if (!enabled) return;
    const root = articleBodyRoot();
    if (!root) return;
    const cleanups: (() => void)[] = [];

    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      if (pre.querySelector('.code-copy')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = t('复制');
      let timer = 0;
      const onClick = async () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        button.textContent = (await copyText(code)) ? t('已复制') : t('复制失败');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          button.textContent = t('复制');
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
  }, [enabled, html, t]);
}
