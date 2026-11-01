import { describe, expect, it } from 'vitest';
import { DICT } from './dict';

/**
 * 文案覆盖率闸门。
 *
 * 迁移是分批做的：每批把中文字面量包裹成 `t('中文')` 并补一条英文。这个测试保证
 * 「已包裹的键一定有英文」，于是随着批次推进，漏译会在测试里当场暴露。
 *
 * 扫描方式用 Vite 的 `import.meta.glob(..., { query: '?raw' })`，不需要 Node 的 fs，
 * 也就不必给前端工程加 `@types/node`。
 */

const sources = import.meta.glob('../../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 只看业务代码：字典与 i18n 内核自己的文件都落在 `./`（相对本测试目录），
 * 业务文件一律是 `../…`。测试文件本身也排除。
 */
function isBusinessSource(path: string): boolean {
  if (!path.startsWith('../')) return false;
  return !/\.test\.tsx?$/.test(path);
}

/** 抓 `t('…')` / `t("…")` / t(`…`) 的字面量键；变量参数跳过。 */
const CALL = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function keysIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(CALL)) {
    const key = match[2].replace(/\\n/g, '\n').replace(/\\(['"`])/g, '$1').replace(/\\\\/g, '\\');
    // 纯标点或空串不是文案，跳过，避免误报。
    if (key.trim()) found.push(key);
  }
  return found;
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

describe('英文文案覆盖率', () => {
  const usages: { path: string; key: string }[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (!isBusinessSource(path)) continue;
    for (const key of keysIn(source)) usages.push({ path, key });
  }

  it('源码里每个 t() 字面量键都能在英文表里找到', () => {
    const missing = usages
      .filter(({ key }) => DICT[key] === undefined)
      .map(({ path, key }) => `${path.replace('../../', '')}: ${key}`);
    expect(missing).toEqual([]);
  });

  it('英文条目里不含中日韩字符', () => {
    const dirty: string[] = [];
    for (const [key, entry] of Object.entries(DICT)) {
      const values = typeof entry === 'string' ? [entry] : [entry.one, entry.other];
      for (const value of values) {
        if (CJK.test(value)) dirty.push(`${key} → ${value}`);
      }
    }
    expect(dirty).toEqual([]);
  });

  it('英文条目的占位符与中文键一一对应', () => {
    const placeholder = (text: string) => new Set(text.match(/\{\w+\}/g) ?? []);
    const sameShape = (key: string, value: string) => {
      const wanted = placeholder(key);
      const got = placeholder(value);
      return [...wanted].every((token) => got.has(token)) && got.size === wanted.size;
    };
    const mismatched: string[] = [];
    for (const [key, entry] of Object.entries(DICT)) {
      if (typeof entry === 'string') {
        if (!sameShape(key, entry)) mismatched.push(`${key} → ${entry}`);
        continue;
      }
      // 单数形式里数量就是 1（"1 minute ago"），允许不再写 {count}；
      // 复数形式必须保留全部占位符。
      if (!sameShape(key, entry.other)) mismatched.push(`${key} → ${entry.other}`);
      for (const token of placeholder(key)) {
        if (placeholder(entry.one).size && !placeholder(entry.one).has(token)) {
          mismatched.push(`${key} → ${entry.one}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});
