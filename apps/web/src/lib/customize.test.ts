import { describe, expect, it } from 'vitest';
import { pageSearchText, readCustomization, starterPages } from './customize';

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
