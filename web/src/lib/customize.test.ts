import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_CSS_CHARS,
  applyCustomizationPatch,
  highRiskCustomCssMarker,
  pageSearchText,
  parseCustomizationFile,
  readCustomization,
  readStoredCustomization,
  sanitizeCustomCss,
  starterPages,
} from './customize';
import { takeMigrationReport } from './migrationNotice';
import { DEFAULT_THEME } from './theme';
import { themeApplyPatch } from './themeSwitch';

describe('readCustomization nested blocks', () => {
  it('keeps recursive children and clamps columns', () => {
    const customization = readCustomization({
      customization: {
        home: {
          blocks: [
            {
              id: 'col',
              type: 'columns',
              title: '两栏',
              props: { columns: 2 },
              animation: 'none',
              hidden: false,
              children: [
                {
                  id: 'txt',
                  type: 'text',
                  title: '文本',
                  props: { title: 'hi', body: 'body' },
                  animation: 'fade',
                  hidden: false,
                  column: 9,
                },
              ],
            },
          ],
        },
      },
    } as never);

    const columns = customization.home.blocks[0];
    expect(columns.children).toHaveLength(1);
    expect(columns.children?.[0].column).toBe(4);
    expect(columns.children?.[0].props.title).toBe('hi');
  });

  it('preserves boolean props instead of stringifying them', () => {
    const customization = readCustomization({
      customization: {
        home: {
          blocks: [
            {
              id: 'video',
              type: 'video',
              title: '视频',
              props: { src: '/v.mp4', show_controls: false, show_pause_button: true },
              animation: 'none',
              hidden: false,
            },
          ],
        },
      },
    } as never);
    const video = customization.home.blocks[0];
    expect(video.props.show_controls).toBe(false);
    expect(video.props.show_pause_button).toBe(true);
  });

  it('drops blocks beyond the depth limit', () => {
    let node: Record<string, unknown> = {
      id: 'leaf',
      type: 'text',
      title: 'leaf',
      props: {},
      animation: 'none',
      hidden: false,
    };
    for (let index = 0; index < 10; index += 1) {
      node = {
        id: `c${index}`,
        type: 'columns',
        title: `c${index}`,
        props: { columns: 2 },
        animation: 'none',
        hidden: false,
        children: [node],
      };
    }
    const customization = readCustomization({
      customization: { home: { blocks: [node] } },
    } as never);
    let depth = 0;
    let current = customization.home.blocks[0];
    while (current?.children?.length) {
      depth += 1;
      current = current.children[0];
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe('页面内容全部来自页面编排', () => {
  const legacyPage = {
    id: 'page_old',
    title: '旧页面',
    slug: 'old',
    summary: '旧摘要',
    body: '## 旧标题\n\n旧正文段落。',
    status: 'published',
    show_in_nav: true,
    created_at: '1',
    updated_at: '1',
  };

  it('旧版 Markdown 正文会迁移成一个文本区块，body 不再保留', () => {
    const customization = readCustomization({ customization: { pages: [legacyPage] } } as never);
    const page = customization.pages[0];
    expect(page.body).toBe('');
    expect(page.layout?.blocks).toHaveLength(1);
    expect(page.layout?.blocks[0].type).toBe('text');
    expect(String(page.layout?.blocks[0].props.body)).toContain('旧正文段落');
  });

  it('已经有区块的页面不会被旧正文覆盖', () => {
    const customization = readCustomization({
      customization: {
        pages: [
          {
            ...legacyPage,
            layout: {
              blocks: [
                { id: 'b1', type: 'text', title: '新块', props: { body: '新内容' }, animation: 'none', hidden: false },
              ],
            },
          },
        ],
      },
    } as never);
    expect(customization.pages[0].layout?.blocks).toHaveLength(1);
    expect(String(customization.pages[0].layout?.blocks[0].props.body)).toBe('新内容');
    expect(customization.pages[0].body).toBe('');
  });

  it('安装示例页只有区块，没有 Markdown 正文', () => {
    for (const page of starterPages()) {
      expect(page.body).toBe('');
      expect(page.layout?.blocks.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('页面搜索会读取区块里的文字', () => {
    const customization = readCustomization({
      customization: {
        pages: [
          {
            ...legacyPage,
            layout: {
              blocks: [
                { id: 'b1', type: 'text', title: '关于', props: { body: '一间隔音很好的书房' }, animation: 'none', hidden: false },
              ],
            },
          },
        ],
      },
    } as never);
    expect(pageSearchText(customization.pages[0])).toContain('一间隔音很好的书房');
  });
});

describe('区块通用外观', () => {
  it('保留合法外观，丢弃未知枚举与坏色值', () => {
    const customization = readCustomization({
      customization: {
        home: {
          blocks: [
            {
              id: 'btn',
              type: 'button',
              title: '按钮',
              props: {},
              animation: 'none',
              hidden: false,
              appearance: {
                radius: 'lg',
                shadow: 'md',
                crop: '16:9',
                background: '#EEF3EF',
                padding: 16,
                border: true,
                unknown: 'ignored',
              },
            },
            {
              id: 'bad',
              type: 'button',
              title: '按钮',
              props: {},
              animation: 'none',
              hidden: false,
              appearance: { radius: 'huge', background: 'javascript:alert(1)', padding: -2 },
            },
          ],
        },
      },
    } as never);

    expect(customization.home.blocks[0].appearance).toEqual({
      radius: 'lg',
      shadow: 'md',
      crop: '16:9',
      background: '#eef3ef',
      padding: 16,
      border: true,
    });
    expect(customization.home.blocks[1].appearance).toBeUndefined();
  });
});

// V-03：custom_css 会随服务端设计分发给每个访客，读入/导出时先剔掉高危构造。
describe('custom_css 内容规范化', () => {
  it('keeps ordinary custom CSS exactly as written', () => {
    const css =
      ':root { --pp-accent: #c33; }\n' +
      'body { background: url("https://cdn.example/bg.png") no-repeat; }\n' +
      '@media (min-width: 900px) { .hero { position: fixed; inset: 0; } }';

    expect(sanitizeCustomCss(css)).toBe(css);
    expect(highRiskCustomCssMarker(css)).toBe('');
  });

  it('drops rules that carry a high risk construct', () => {
    const css =
      '@import url("https://evil.example/x.css");\n' +
      'body { color: #222; }\n' +
      'a { background: url(javascript:alert(1)); }\n' +
      '.ok { padding: 8px; }';

    const sanitized = sanitizeCustomCss(css);

    expect(sanitized).toContain('body { color: #222; }');
    expect(sanitized).toContain('.ok { padding: 8px; }');
    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('javascript:');
    expect(highRiskCustomCssMarker(sanitized)).toBe('');
  });

  it('detects escaped and comment-split spellings', () => {
    for (const payload of [
      '@im/* hidden */port url("https://evil.example/x.css");',
      '\\40 import url("https://evil.example/x.css");',
      'body { width: expression(alert(1)); }',
      'a { behavior: url(evil.htc); }',
      'a { -moz-binding: url(evil.xml#x); }',
      'a { background: url(\u0027javascript:alert(1)\u0027); }',
      'a { background: url(data:text/html;base64,PHNjcmlwdD4=); }',
    ]) {
      expect(highRiskCustomCssMarker(payload), payload).not.toBe('');
    }
  });

  it('drops a whole at-rule block when the payload is nested inside it', () => {
    const sanitized = sanitizeCustomCss(
      '@media screen { .x { background: url(javascript:alert(1)); } }\n.y { color: red; }',
    );

    expect(sanitized).toBe('.y { color: red; }');
  });

  it('caps the field at the frontend limit', () => {
    const huge = `a { color: red; }\n${'/* pad */'.repeat(4000)}`;

    expect(sanitizeCustomCss(huge).length).toBe(MAX_CUSTOM_CSS_CHARS);
  });

  it('is idempotent', () => {
    const once = sanitizeCustomCss('a { background: url(javascript:alert(1)); }\n.b { color: red; }');

    expect(sanitizeCustomCss(once)).toBe(once);
  });

  it('readCustomization filters the stored document', () => {
    const customization = readCustomization({
      customization: {
        custom_css: 'html { outline: 9px solid red; }\n@import url("https://evil.example/x.css");',
      },
    } as never);

    expect(customization.custom_css).toContain('outline: 9px solid red');
    expect(customization.custom_css).not.toContain('@import');
  });
});

// 规格 §5.1：折算改写了作者的版面，读取路径必须把迁移器写的报告交出来——
// 后台的「版面已自动升级」提示就是从这里拿数据的。
describe('版面迁移报告', () => {
  it('折算分端编排之后把报告发布到内存队列', () => {
    // 先清掉上一条用例可能留下的报告，断言的就是这一次读取。
    takeMigrationReport();
    const block = {
      id: 'hero',
      type: 'text',
      title: '标题',
      props: { title: '你好', body: '正文' },
      animation: 'fade',
      hidden: false,
    };

    readCustomization({
      customization: {
        home: {
          blocks: [block],
          device_split: true,
          devices: {
            desktop: { blocks: [block] },
            // 手机树只有展示层字段不同：可以被折算进 at，因此会产生报告。
            mobile: { blocks: [{ ...block, animation: 'none' }] },
          },
        },
      },
    } as never);

    const report = takeMigrationReport();
    expect(report).not.toEqual([]);
    expect(report.join('\n')).toContain('首页');
    // 取走即清空：同一会话里第二个组件不会重复弹窗。
    expect(takeMigrationReport()).toEqual([]);
  });
});

describe('按主题保存的首页/文章页编排', () => {
  const legacyBlock = { id: 'legacy', type: 'text', title: '旧首页', props: {} };

  function configWithLayouts() {
    return {
      customization: {
        theme: { ...DEFAULT_THEME },
        layout: { variant: 'classic' },
        active_theme: 'theme_a',
        themes: [
          { id: 'theme_a', name: 'A', note: '' },
          {
            id: 'theme_b',
            name: 'B',
            note: '',
            variant: 'bento',
            theme: { ...DEFAULT_THEME },
          },
        ],
        home: { blocks: [legacyBlock] },
        article: { blocks: [] },
        theme_layouts: {
          theme_a: {
            home: { blocks: [] },
            article: { blocks: [{ id: 'a-art', type: 'text', title: 'A 文章页', props: {} }] },
          },
          theme_b: {
            home: { blocks: [{ id: 'b-home', type: 'text', title: 'B 首页', props: {} }] },
          },
          missing: {
            home: { blocks: [{ id: 'gone', type: 'text', title: '已删除主题', props: {} }] },
          },
        },
      },
    };
  }

  it('当前主题的条目覆盖站点级编排；显式空编排保持空白', () => {
    const customization = readCustomization(configWithLayouts() as never);
    expect(customization.home.blocks).toHaveLength(0);
    expect(customization.article?.blocks[0]?.id).toBe('a-art');
    // 不再存在的主题 id 会被清掉，避免设计文档无限膨胀。
    expect(customization.theme_layouts?.missing).toBeUndefined();
  });

  it('切换主题时整套编排跟着切换，没有条目的那一类回退站点级', () => {
    const raw = configWithLayouts();
    const customization = readCustomization({
      customization: { ...raw.customization, active_theme: 'theme_b' },
    } as never);
    expect(customization.home.blocks[0]?.id).toBe('b-home');
    // theme_b 没有自己的文章页编排，沿用站点级 article（空）。
    expect(customization.article?.blocks).toHaveLength(0);
  });

  it('旧配置没有 theme_layouts 时读取结果不变', () => {
    const customization = readCustomization({
      customization: {
        theme: { ...DEFAULT_THEME },
        layout: { variant: 'classic' },
        home: { blocks: [legacyBlock] },
      },
    } as never);
    expect(customization.home.blocks[0]?.id).toBe('legacy');
    expect(customization.theme_layouts).toBeUndefined();
  });

  it('已存形状不投影主题编排；渲染视图才投影', () => {
    const stored = readStoredCustomization(configWithLayouts() as never);
    expect(stored.home.blocks[0]?.id).toBe('legacy');
    expect(stored.article?.blocks).toHaveLength(0);
    expect(stored.theme_layouts?.theme_a?.home?.blocks).toHaveLength(0);

    const effective = readCustomization(configWithLayouts() as never);
    expect(effective.home.blocks).toHaveLength(0);
  });

  it('编辑当前主题首页后切换主题再切回，编排仍在', () => {
    let state = readStoredCustomization(configWithLayouts() as never);
    state = applyCustomizationPatch(state, {
      home: {
        blocks: [
          { id: 'a-edit', type: 'text', title: 'A 编辑', props: {}, animation: 'none', hidden: false },
        ],
      },
    });
    expect(state.theme_layouts?.theme_a?.home?.blocks[0]?.id).toBe('a-edit');

    // 切到 theme_b
    let effective = readCustomization({ customization: state } as never);
    state = applyCustomizationPatch(
      state,
      themeApplyPatch(effective, {
        id: 'theme_b',
        name: 'B',
        note: '',
        variant: 'bento',
        theme: { ...DEFAULT_THEME },
      }).patch,
    );

    // 切回 theme_a：它自己的编排不应该被切换清空。
    effective = readCustomization({ customization: state } as never);
    state = applyCustomizationPatch(
      state,
      themeApplyPatch(effective, { id: 'theme_a', name: 'A', note: '' }).patch,
    );
    const final = readCustomization({ customization: state } as never);
    expect(final.home.blocks[0]?.id).toBe('a-edit');
  });

  it('整份设计导入保存的是未投影的已存形状', () => {
    const parsed = parseCustomizationFile(
      JSON.stringify({
        customization: {
          theme: { ...DEFAULT_THEME },
          layout: { variant: 'classic' },
          active_theme: 'theme_a',
          themes: [{ id: 'theme_a', name: 'A', note: '' }],
          theme_layouts: { theme_a: { home: { blocks: [] } } },
          home: { blocks: [legacyBlock] },
          article: { blocks: [] },
        },
      }),
    );
    // 导入保存的顶层 home 仍是站点级旧值，不是活动主题的空白编排。
    expect(parsed.home.blocks[0]?.id).toBe('legacy');
    expect(parsed.theme_layouts?.theme_a?.home?.blocks).toHaveLength(0);
  });

  it('update 写 home/article 时路由到当前主题，顶层旧值不动', () => {
    const current = readStoredCustomization({
      customization: {
        theme: { ...DEFAULT_THEME },
        layout: { variant: 'classic' },
        home: { blocks: [legacyBlock] },
      },
    } as never);
    const next = applyCustomizationPatch(current, {
      home: { blocks: [] },
      article: {
        blocks: [{ id: 'art', type: 'text', title: '文章页', props: {}, animation: 'none', hidden: false }],
      },
    });
    expect(next.home.blocks[0]?.id).toBe('legacy');
    expect(next.theme_layouts?.default?.home?.blocks).toHaveLength(0);
    expect(next.theme_layouts?.default?.article?.blocks[0]?.id).toBe('art');
  });

  it('显式带 theme_layouts 的补丁不路由，便于导入/创建整套主题', () => {
    const current = readStoredCustomization({
      customization: {
        theme: { ...DEFAULT_THEME },
        layout: { variant: 'classic' },
        home: { blocks: [legacyBlock] },
      },
    } as never);
    const next = applyCustomizationPatch(current, {
      theme_layouts: { theme_x: { home: { blocks: [] } } },
    });
    expect(next.home.blocks[0]?.id).toBe('legacy');
    expect(next.theme_layouts?.theme_x?.home?.blocks).toHaveLength(0);
  });
});

describe('夜航文章外观', () => {
  it('旧配置没有这个字段时保持原来的封面在上', () => {
    const customization = readCustomization({
      customization: { layout: { variant: 'bento' } },
    } as never);

    expect(customization.layout.article_card_style).toBe('cover');
  });

  it('保留 blur，未知值回退到 cover', () => {
    const blur = readCustomization({
      customization: { layout: { variant: 'bento', article_card_style: 'blur' } },
    } as never);
    expect(blur.layout.article_card_style).toBe('blur');

    const unknown = readCustomization({
      customization: { layout: { variant: 'bento', article_card_style: 'glass' } },
    } as never);
    expect(unknown.layout.article_card_style).toBe('cover');
  });
});
