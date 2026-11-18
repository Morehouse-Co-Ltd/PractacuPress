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
 * 响应式那一半写在 CSS 里：渲染器只把三档取值写进自定义属性，由媒体查询按**视口宽度**
 * 决定谁生效。这几条断言把「渲染器写的变量名」「styles.css 里的变量名」和「唯一断点表」
 * 焊在一起，改一边不改另一边会在测试里当场断掉。
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

describe('栅格断点用媒体查询实现（设备只由视口定义）', () => {
  it('栅格不再是容器：container-type / container-name 都去掉了', () => {
    expect(gridCss).not.toMatch(/\.pp-grid\s*\{[^}]*container-type/);
    expect(gridCss).not.toMatch(/\.pp-grid\s*\{[^}]*container-name/);
    expect(gridCss).not.toContain('container-name: pp-grid');
  });

  it('没有任何 @container 档位还挂在 .pp-grid 上', () => {
    // 容器查询会给出第二套"我是哪台设备"：容器窄到 640px 时栅格按手机排，
    // 而 `at` 覆盖层按视口算出来是桌面。档位只能有一个判据。
    expect(gridCss).not.toMatch(/@container[^{]*\{[^}]*\.pp-grid/);
  });

  it('单元格的起始列与宽度都来自自定义属性（三档只在 CSS 里切换）', () => {
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*grid-column-start:\s*var\(--pp-col-start\)/);
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*grid-column-end:\s*span var\(--pp-col-span\)/);
    expect(gridCss).toMatch(/--pp-col-start:\s*calc\(var\(--pp-offset-base\) \+ 1\)/);
    expect(gridCss).toMatch(/--pp-col-span:\s*var\(--pp-span-base\)/);
  });

  it('移动优先：基准取 sm，768px 提 md，1024px 提 base（桌面档）', () => {
    // 基准规则 = 手机档：容器再窄也不改档，窄排版要靠 `at` 覆盖。
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*--pp-col-span:\s*var\(--pp-span-sm\)/);
    expect(gridCss).toMatch(/\.pp-grid-cell\s*\{[^}]*--pp-col-start:\s*calc\(var\(--pp-offset-sm\) \+ 1\)/);

    const md = new RegExp(
      `@media\\s*\\(min-width:\\s*${BREAKPOINT_MD}px\\)\\s*\\{[^}]*\\.pp-grid-cell\\s*\\{[^}]*` +
        '--pp-col-span:\\s*var\\(--pp-span-md\\)',
    );
    const lg = new RegExp(
      `@media\\s*\\(min-width:\\s*${BREAKPOINT_LG}px\\)\\s*\\{[^}]*\\.pp-grid-cell\\s*\\{[^}]*` +
        '--pp-col-span:\\s*var\\(--pp-span-base\\)',
    );
    expect(gridCss).toMatch(md);
    expect(gridCss).toMatch(lg);

    // 偏移与宽度同一档一起切换，不会一半 md 一半 base。
    expect(gridCss).toMatch(
      new RegExp(
        `@media\\s*\\(min-width:\\s*${BREAKPOINT_MD}px\\)\\s*\\{[^}]*\\.pp-grid-cell\\s*\\{[^}]*` +
          '--pp-col-start:\\s*calc\\(var\\(--pp-offset-md\\) \\+ 1\\)',
      ),
    );
    expect(gridCss).toMatch(
      new RegExp(
        `@media\\s*\\(min-width:\\s*${BREAKPOINT_LG}px\\)\\s*\\{[^}]*\\.pp-grid-cell\\s*\\{[^}]*` +
          '--pp-col-start:\\s*calc\\(var\\(--pp-offset-base\\) \\+ 1\\)',
      ),
    );
  });

  it('两个阈值的字面量就是唯一断点表里的 768 / 1024', () => {
    expect(gridCss).toContain('@media (min-width: 768px)');
    expect(gridCss).toContain('@media (min-width: 1024px)');
    expect(BREAKPOINT_MD).toBe(768);
    expect(BREAKPOINT_LG).toBe(1024);
  });
});
