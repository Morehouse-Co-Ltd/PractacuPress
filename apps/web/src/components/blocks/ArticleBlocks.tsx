import type { ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { useCustomization } from '../../lib/customize';
import { useT } from '../../lib/i18n';
import { ArticleToc, useArticleToc } from '../ArticleTools';
import { useArticleSurface } from './ArticleContext';

/**
 * 「文章内容」占位符。
 *
 * 页面编排里它只是一个占位块：文章页渲染真实正文，其它页面显示虚线占位卡。
 * 正文容器沿用 `.article-body` 类名，并额外打上 `data-pp-article-body` 标记：
 * 编排里的文本组件正文也带 `.article-body`，标记让目录 / 代码复制 / 图表水合
 * 这些页面级工具能认出「这才是当前文章的正文」（见 `components/ArticleTools.tsx`）。
 */

/** 是否在页面编排器的 iframe 预览里（判断方式与 `PreviewBridge` 一致）。 */
function inBuilderPreview(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.parent !== window;
  } catch {
    // 跨域父窗口读不到：当作普通前台访问。
    return false;
  }
}

function Placeholder({ note, preview }: { note: string; preview: boolean }) {
  const t = useT();
  return (
    <div
      className={`pp-article-placeholder${preview ? ' is-preview' : ''}`}
      role="note"
      aria-label={t('文章内容')}
    >
      <p className="pp-article-placeholder-title">{t('文章内容')}</p>
      <p className="pp-article-placeholder-note">{note}</p>
      {preview ? (
        <span className="pp-article-badge" aria-hidden>
          {t('文章内容')}
        </span>
      ) : null}
    </div>
  );
}

export function ArticleContentBlock({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const surface = useArticleSurface();
  const { customization } = useCustomization();
  const showToc = blockProp(block, 'show_toc', false);
  const preview = inBuilderPreview();
  const html = surface?.article.rendered_html ?? '';
  // 复用它即可：`useArticleToc` 优先读 `[data-pp-article-body]`，也就是下面这个容器。
  const toc = useArticleToc(html);

  if (!surface) {
    return <Placeholder note={t('这里会显示文章正文；只在文章页生效。')} preview={preview} />;
  }

  if (!html.trim()) {
    return <Placeholder note={t('这篇文章还没有正文。')} preview={preview} />;
  }

  // 文章页的目录有两个来源：站点级「外观 → 目录」（详情页在编排区块之前渲染）
  // 和这个区块的「显示目录」。站点级已经打开时不再重复画一份。
  const showTocHere = showToc && !customization.extensions.toc && toc.length > 0;

  return (
    <div className={`pp-article-content${preview ? ' is-preview' : ''}`}>
      {showTocHere ? <ArticleToc items={toc} /> : null}
      <div
        className="article-body"
        data-pp-article-body={surface.article.id}
        // 契约规定：只渲染服务端清洗后产生的 rendered_html。
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {preview ? (
        <span className="pp-article-badge" aria-hidden>
          {t('文章内容')}
        </span>
      ) : null}
    </div>
  );
}

export const ARTICLE_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'article-content': ArticleContentBlock,
};
