import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import gridCss from '../styles.css?raw';
import { gridCellVars, gridPlacements, gridTemplate, spanFor } from './blocks';
import { BREAKPOINT_LG, BREAKPOINT_MD } from './layout';

function mk(extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id: 'g', type: 'grid', title: 'g', props: {}, animation: 'none', hidden: false, ...extra };
}

describe('gridTemplate', () => {
  it('默认 12 栏、间距档位 4', () => {
    expect(gridTemplate(mk({ props: {} }))).toEqual({ columns: 12, gap: 16 });
  });
  it('栏数夹在 1–12', () => {
    expect(gridTemplate(mk({ props: { columns: 99 } })).columns).toBe(12);
    expect(gridTemplate(mk({ props: { columns: 0 } })).columns).toBe(1);
  });
  it('间距走标尺，非法档位回落到实心默认', () => {
    expect(gridTemplate(mk({ props: { gap: 9 } })).gap).toBe(96);
    expect(gridTemplate(mk({ props: { gap: 99 } })).gap).toBe(16);
  });
});

describe('spanFor', () => {
  it('没有 span 时占满整行', () => {
    expect(spanFor(mk(), 'desktop')).toEqual({ span: 12, offset: 0 });
  });
  it('按断点取 span', () => {
    const block = mk({ span: { base: 6, md: 8, sm: 12 }, offset: { base: 1 } });
    expect(spanFor(block, 'desktop')).toEqual({ span: 6, offset: 1 });
    expect(spanFor(block, 'tablet')).toEqual({ span: 8, offset: 1 });
    expect(spanFor(block, 'mobile')).toEqual({ span: 12, offset: 1 });
  });
  it('越界一律夹住', () => {
    expect(spanFor(mk({ span: { base: 99 }, offset: { base: 99 } }), 'desktop')).toEqual({
      span: 12,
      offset: 11,
    });
  });
});

describe('gridPlacements', () => {
  it('给出 base / md / sm 三档，未写的档位继承 base', () => {
    const block = mk({ span: { base: 12, md: 6, sm: 12 } });
    expect(gridPlacements(block, 12)).toEqual({
      base: { span: 12, offset: 0 },
      md: { span: 6, offset: 0 },
      sm: { span: 12, offset: 0 },
    });
    expect(gridPlacements(mk({ span: { base: 4 } }), 12)).toEqual({
      base: { span: 4, offset: 0 },
      md: { span: 4, offset: 0 },
      sm: { span: 4, offset: 0 },
    });
  });

  it('offset + span 收进栏数内，逐档各夹一次', () => {
    // 12 栏里只有 6 栏宽，最多只能从第 7 栏起（offset 6）。
    const block = mk({ span: { base: 6, md: 12 }, offset: { base: 9, md: 9 } });
    expect(gridPlacements(block, 12)).toEqual({
      base: { span: 6, offset: 6 },
      md: { span: 12, offset: 0 },
      sm: { span: 6, offset: 6 },
    });
    // 4 栏容器：span 超过栏数时按整行算，offset 归零。
    expect(gridPlacements(mk({ span: { base: 6 }, offset: { base: 3 } }), 4).base).toEqual({
      span: 4,
      offset: 0,
    });
  });

  it('栏数非法时按 1 栏兜底，不会产出 0 或负数', () => {
    expect(gridPlacements(mk({ span: { base: 6 } }), 0).base).toEqual({ span: 1, offset: 0 });
  });
});

/**
 * 响应式那一半写在 CSS 里：渲染器只把三档取值写进自定义属性，由容器查询决定谁生效。
 * 这几条断言把「渲染器写的变量名」和「styles.css 里的变量名」焊在一起，
 * 改一边不改另一边会在测试里当场断掉。
 */
describe('gridCellVars', () => {
  it('把三档落位写成自定义属性，交给 CSS 挑档', () => {
    expect(gridCellVars(mk({ span: { base: 12, md: 6, sm: 12 } }), 12)).toEqual({
      '--pp-span-base': '12',
      '--pp-offset-base': '0',
      '--pp-span-md': '6',
      '--pp-offset-md': '0',
      '--pp-span-sm': '12',
      '--pp-offset-sm': '0',
    });
  });

  it('渲染器写的每个变量名，样式表都读过（改一边就会断）', () => {
    for (const name of Object.keys(gridCellVars(mk(), 12))) {
      expect(gridCss).toContain(`var(${name})`);
    }
  });
});

describe('栅格断点用容器查询实现', () => {
  it('栅格自身是 inline-size 容器', () => {
    expect(gridCss).toMatch(/\.pp-grid\s*\{[^}]*container-type:\s*inline-size/);
    expect(gridCss).toMatch(/\.pp-grid\s*\{[^}]*container-name:\s*pp-grid/);
  });

  it('单元格的起始列与宽度都来自自定义属性（三档只在 CSS 里切换）', () => {
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*grid-column-start:\s*var\(--pp-col-start\)/);
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*grid-column-end:\s*span var\(--pp-col-span\)/);
    expect(gridCss).toMatch(/--pp-col-start:\s*calc\(var\(--pp-offset-base\) \+ 1\)/);
    expect(gridCss).toMatch(/--pp-col-span:\s*var\(--pp-span-base\)/);
  });

  it('平板 / 手机两档各有一条容器查询，阈值来自唯一断点表', () => {
    const md = BREAKPOINT_LG - 1;
    const sm = BREAKPOINT_MD - 1;
    expect(gridCss).toContain(`@container pp-grid (max-width: ${md}px)`);
    expect(gridCss).toContain(`@container pp-grid (max-width: ${sm}px)`);
    // 容器查询而不是媒体查询：预览 iframe 改宽度时媒体查询看的是外层窗口。
    expect(gridCss.match(/@media[^{]*\{[^}]*\.pp-grid/g)).toBeNull();
  });

  it('三档都切到对应的变量，且尺寸档缺省时回落到 base', () => {
    expect(gridCss).toMatch(/--pp-col-span:\s*var\(--pp-span-md\)/);
    expect(gridCss).toMatch(/--pp-col-span:\s*var\(--pp-span-sm\)/);
    expect(gridCss).toMatch(/--pp-col-start:\s*calc\(var\(--pp-offset-md\) \+ 1\)/);
    expect(gridCss).toMatch(/--pp-col-start:\s*calc\(var\(--pp-offset-sm\) \+ 1\)/);
  });
});
