import { useEffect, useRef, type HTMLAttributes } from 'react';
import { enhanceContentImages } from '../lib/markdown';
import { enhanceVideoCards } from '../lib/videoEmbed';

interface ResponsiveHtmlProps extends HTMLAttributes<HTMLDivElement> {
  /** 服务端清洗后的正文 HTML。 */
  html: string;
  /** 文章页用来让目录 / 代码复制等工具认出真正的正文容器。 */
  'data-pp-article-body'?: string;
}

/**
 * 渲染服务端清洗后的正文，并在挂载后补上响应式图片属性。
 *
 * 发布正文的清洗白名单不允许 `srcset` / `loading` / `decoding`，但这些属性是纯展示
 * 性能信息，不改变文档结构。挂载后只读取已经清洗过的 `src` 并派生属性，不引入任何
 * 新 HTML，因此不会绕过服务端的安全边界。
 */
export function ResponsiveHtml({ html, ...rest }: ResponsiveHtmlProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    enhanceContentImages(ref.current);
    enhanceVideoCards(ref.current);
  }, [html]);

  return <div ref={ref} {...rest} dangerouslySetInnerHTML={{ __html: html }} />;
}
