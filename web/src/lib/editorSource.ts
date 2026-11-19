import type { SourceFormat } from '../types';
import { htmlToMarkdown } from './htmlToMarkdown';
import { renderMarkdown, renderSource } from './markdown';

export interface EditorSource {
  markdown: string;
  html: string;
}

/** Normalize historical source formats into the Markdown-backed WYSIWYG model. */
export function normalizeEditorSource(format: SourceFormat, source: string): EditorSource {
  if (format === 'markdown') {
    return { markdown: source, html: renderMarkdown(source) };
  }

  const safeHtml = renderSource(format, source);
  const markdown = htmlToMarkdown(safeHtml);
  return { markdown, html: renderMarkdown(markdown) };
}
