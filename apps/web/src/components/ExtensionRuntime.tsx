import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import type { CustomExtension, ExtensionSlot } from '../types';
import { useCustomization } from '../lib/customize';
import { isPreviewFrame } from '../lib/access';
import {
  matchPageScope,
  pageKindForPath,
  slotMatchesPage,
  type ExtensionDocumentContext,
  type ExtensionPageKind,
} from '../lib/extensions';
import { ExtensionHost } from './ExtensionHost';

/**
 * 创作者扩展的前台运行时。
 *
 * 职责：
 * 1. 按当前路由判断页面类型（home / article / list / search），筛出启用且 pages 命中的扩展；
 * 2. 在宿主的真实 DOM 里为每个槽位创建一个锚点 div，再用 createPortal 把 iframe 宿主挂进去，
 *    让扩展出现在页头、文章正文之后等真实位置；
 * 3. 页面数据是异步加载的，锚点可能晚出现：MutationObserver + 前 2 秒的短重试；
 * 4. 预览 iframe（页面编排 / 加载动画的预览）里不重复挂载，避免后台预览出现两套扩展。
 *
 * 槽位规则：
 * - site_header / site_footer：整个站点外壳，任何页面都尝试；
 * - home_*：只在首页；article_*：只在文章 / 帖子详情页；
 * - floating：不占文档流，固定在右下角。
 */

type Placement = { parent: Node; before: Node | null };

/** 把锚点容器插到指定位置；父节点已被 React 移除时返回 false，等下一轮重试。 */
function insertPlacement(container: HTMLElement, placement: Placement): boolean {
  // 父节点可能在异步渲染中被换掉：重新确认仍然是当前 DOM 里的节点。
  if (!placement.parent.isConnected) return false;
  placement.parent.insertBefore(container, placement.before);
  return true;
}

/** 槽位在真实 DOM 里的插入位置；找不到说明当前页面没有这个位置。 */
function findPlacement(slot: ExtensionSlot): Placement | null {
  const main = document.querySelector<HTMLElement>('main#main') ?? document.querySelector<HTMLElement>('main');
  switch (slot) {
    case 'site_header': {
      const header = document.querySelector('.site-header');
      return header?.parentNode ? { parent: header.parentNode, before: header.nextSibling } : null;
    }
    case 'site_footer': {
      const footer = document.querySelector('.site-footer');
      if (footer?.parentNode) return { parent: footer.parentNode, before: footer };
      // 认证页等没有页脚时退回到 main 之后。
      return main?.parentNode ? { parent: main.parentNode, before: main.nextSibling } : null;
    }
    case 'home_top': {
      if (!main) return null;
      return { parent: main, before: main.firstChild };
    }
    case 'home_bottom': {
      if (!main) return null;
      return { parent: main, before: null };
    }
    case 'article_top': {
      const cover = document.querySelector('.article-cover');
      if (cover?.parentNode) return { parent: cover.parentNode, before: cover.nextSibling };
      const body = document.querySelector('.article-body');
      return body?.parentNode ? { parent: body.parentNode, before: body } : null;
    }
    case 'article_bottom': {
      const foot = document.querySelector('.article-foot');
      if (foot?.parentNode) return { parent: foot.parentNode, before: foot.nextSibling };
      const comments = document.querySelector('.comments');
      return comments?.parentNode ? { parent: comments.parentNode, before: comments } : null;
    }
    case 'article_side': {
      const article = document.querySelector('.article');
      if (!article) return null;
      const body = article.querySelector('.article-body');
      if (body?.parentNode) return { parent: body.parentNode, before: body.nextSibling };
      return { parent: article, before: null };
    }
    default:
      return null;
  }
}

function contextForExtension(
  extension: CustomExtension,
  pageKind: ExtensionPageKind,
  title: string,
  theme: { background: string; ink: string; accent: string; font: 'serif' | 'sans' },
): ExtensionDocumentContext {
  return {
    theme: { ...theme },
    page: pageKind,
    title,
    extensionId: extension.id,
  };
}

/** 前台扩展运行时；没有启用的扩展或处于预览 iframe 时什么都不渲染。 */
export function ExtensionRuntime() {
  const { customization } = useCustomization();
  const location = useLocation();
  const preview = useMemo(() => isPreviewFrame(), []);
  const pageKind = pageKindForPath(location.pathname);
  const theme = customization.theme;

  // 按配置顺序筛出当前页应该运行的扩展；数组身份在配置不变时是稳定的。
  const activeExtensions = useMemo(
    () => customization.custom_extensions.filter((extension) => extension.enabled && matchPageScope(extension, pageKind)),
    [customization.custom_extensions, pageKind],
  );

  // 槽位 → 扩展开启了哪些；floating 直接渲染，其它槽位需要 DOM 锚点。
  const bySlot = useMemo(() => {
    const map = new Map<ExtensionSlot, CustomExtension[]>();
    for (const extension of activeExtensions) {
      for (const slot of extension.slots) {
        if (!slotMatchesPage(slot, pageKind)) continue;
        const list = map.get(slot);
        if (list) list.push(extension);
        else map.set(slot, [extension]);
      }
    }
    return map;
  }, [activeExtensions, pageKind]);

  // 只有内容真正变化（id / 保存时间 / 槽位 / 页面）才重建锚点；切主题不重挂 iframe。
  const activeSignature = activeExtensions
    .map((extension) => `${extension.id}@${extension.updated_at}:${extension.slots.join(',')}:${extension.pages.join(',')}`)
    .join('|');

  const [slotEls, setSlotEls] = useState<Record<string, HTMLElement>>({});
  // 文章标题用于 PP 上下文；正文加载完后补一次，避免页头 / 悬浮扩展拿到空标题。
  const [articleTitle, setArticleTitle] = useState('');
  const activeRef = useRef(activeExtensions);
  activeRef.current = activeExtensions;
  const routeKey = location.pathname;

  useEffect(() => {
    if (preview) return;
    const extensions = activeRef.current.filter((extension) => extension.enabled && matchPageScope(extension, pageKind));
    const wanted = new Set<ExtensionSlot>();
    let hasFloating = false;
    for (const extension of extensions) {
      for (const slot of extension.slots) {
        if (slot === 'floating') {
          hasFloating = true;
          continue;
        }
        if (!slotMatchesPage(slot, pageKind)) continue;
        wanted.add(slot);
      }
    }
    if (!wanted.size && !hasFloating) {
      setSlotEls((previous) => (Object.keys(previous).length ? {} : previous));
      setArticleTitle('');
      return;
    }

    let disposed = false;
    let frame = 0;
    const mounted = new Map<ExtensionSlot, HTMLElement>();

    const flush = () => {
      if (disposed) return;
      setSlotEls((previous) => {
        const next = Object.fromEntries(mounted) as Record<string, HTMLElement>;
        const prevKeys = Object.keys(previous);
        const nextKeys = Object.keys(next);
        if (prevKeys.length === nextKeys.length && nextKeys.every((key) => previous[key] === next[key])) {
          return previous;
        }
        return next;
      });
    };

    const scan = () => {
      if (disposed) return;

      // 0) 文章标题随异步内容出现，和锚点同一次扫描里同步。
      const nextTitle =
        pageKind === 'article'
          ? (document.querySelector<HTMLElement>('.article h1')?.textContent ?? '').trim()
          : '';
      setArticleTitle((previous) => (previous === nextTitle ? previous : nextTitle));

      // 1) 移除不再需要的槽位（扩展被关闭、页面类型变化）。
      for (const [slot, element] of Array.from(mounted.entries())) {
        if (wanted.has(slot)) continue;
        element.remove();
        mounted.delete(slot);
      }

      // 2) React 重渲染可能把旧锚点连同父节点一起换掉；失联的重新创建。
      for (const [slot, element] of Array.from(mounted.entries())) {
        if (element.isConnected) continue;
        mounted.delete(slot);
      }

      // 3) 为还没挂上的槽位找位置并插入锚点。
      for (const slot of wanted) {
        if (mounted.has(slot)) continue;
        const placement = findPlacement(slot);
        if (!placement) continue;
        const container = document.createElement('div');
        container.className = 'ppe-slot';
        container.dataset.ppExtSlot = slot;
        if (!insertPlacement(container, placement)) continue;
        mounted.set(slot, container);
      }

      flush();
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    };

    scan();

    // 异步内容（文章正文、评论、首页列表）会在挂载后陆续出现，观察整棵文档。
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(schedule);
    observer?.observe(document.body, { childList: true, subtree: true });

    // 前 2 秒再补几次，覆盖“首帧为空 → 数据到达”的常见时序。
    const retries = [80, 240, 600, 1200, 2000].map((delay) => window.setTimeout(scan, delay));

    return () => {
      disposed = true;
      observer?.disconnect();
      retries.forEach((timer) => window.clearTimeout(timer));
      if (frame) window.cancelAnimationFrame(frame);
      mounted.forEach((element) => element.remove());
      mounted.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, pageKind, routeKey, activeSignature]);

  if (preview) return null;

  const documentContext = (extension: CustomExtension) =>
    contextForExtension(
      extension,
      pageKind,
      articleTitle,
      {
        background: theme.background,
        ink: theme.ink,
        accent: theme.accent,
        font: theme.heading_font,
      },
    );

  const renderHost = (extension: CustomExtension) => (
    <ExtensionHost
      key={`${extension.id}:${extension.updated_at}`}
      extension={extension}
      context={documentContext(extension)}
    />
  );

  const floating = bySlot.get('floating') ?? [];

  return (
    <>
      {Array.from(bySlot.entries()).map(([slot, list]) => {
        if (slot === 'floating') return null;
        const target = slotEls[slot];
        if (!target || !list.length) return null;
        return createPortal(
          <div className="ppe-slot-inner" data-pp-ext-slot={slot}>
            {list.map(renderHost)}
          </div>,
          target,
          slot,
        );
      })}
      {floating.length ? (
        <div className="ppe-floating" data-pp-ext-slot="floating">
          {floating.map(renderHost)}
        </div>
      ) : null}
    </>
  );
}
