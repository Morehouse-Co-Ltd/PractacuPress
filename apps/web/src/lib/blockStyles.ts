import type { CSSProperties } from 'react';

/**
 * 文本区块的“作用域 CSS”。
 *
 * 只接受声明（property: value;），不接受选择器或 @ 规则，并由 React 作为内联
 * style 应用。这样用户能调字号、字距、颜色、间距，但不可能把样式泄漏到别的区块，
 * 也不会生成可被注入的全局 <style>。
 */

const BLOCKED = /[{}<>@]|expression\(|javascript:|url\(/i;
const PROPERTY = /^[a-z][a-z0-9-]*$/;

const camelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function styleDeclarations(input: unknown): CSSProperties {
  if (typeof input !== 'string' || !input.trim()) return {};
  const style: Record<string, string> = {};
  for (const chunk of input.split(';')) {
    const index = chunk.indexOf(':');
    if (index <= 0) continue;
    const name = chunk.slice(0, index).trim().toLowerCase();
    const value = chunk.slice(index + 1).trim();
    if (!PROPERTY.test(name) || !value || BLOCKED.test(value)) continue;
    if (value.length > 160) continue;
    style[camelCase(name)] = value;
  }
  return style as CSSProperties;
}
