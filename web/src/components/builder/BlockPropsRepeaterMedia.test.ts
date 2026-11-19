import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockProps } from './BlockProps';
import { createBlock } from '../../lib/blocks';
import { BackendProvider, type Backend } from '../../lib/backend';
import type { Asset, BlockProps as BlockPropsValue, BlockInstance } from '../../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * repeater 行里的 `media` 子字段。
 *
 * P2 的 team / logo-wall / gallery 三个区块，条目里带头像或图片。这里走真实渲染，
 * 盯住三件事：媒体行走和顶层 `media` 属性同一套「输入框 + 从媒体库选择」；
 * 普通 `text` 子字段没有被顺手改掉；选中的地址只写回命中的那一行，而且仍然是
 * 一个纯 URL 字符串。
 *
 * 选择器要从媒体库读资产，所以这里给一个只实现 `listAssets` 的假 Backend。
 */

const ASSET: Asset = {
  id: 'asset-1',
  storage_key: 'media/asset-1',
  mime_type: 'image/png',
  size: 1024,
  scan_status: 'clean',
  url: '/api/v1/media/asset-1',
  file_name: 'asset-1.png',
};

function fakeBackend(assets: Asset[]): Backend {
  return { listAssets: async () => assets } as unknown as Backend;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: BlockPropsValue = {};

function mount(
  block: BlockInstance,
  onChange: (props: BlockPropsValue) => void = () => {},
  assets: Asset[] = [],
) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(BackendProvider, {
        backend: fakeBackend(assets),
        children: createElement(BlockProps, { block, onChange }),
      }),
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  latest = {};
});

function teamBlock(items: Record<string, string>[]): BlockInstance {
  const block = createBlock('team');
  block.props = { ...block.props, items };
  return block;
}

function rows(view: HTMLElement): HTMLElement[] {
  return [...view.querySelectorAll('.itemlist-row')] as HTMLElement[];
}

/** 按 aria-label 找某一行的子字段控件——行号 + 字段名都在里面。 */
function fieldOf(row: HTMLElement, field: string): HTMLElement {
  const node = [...row.querySelectorAll('input')].find((input) =>
    input.getAttribute('aria-label')?.includes(field),
  );
  if (!node) throw new Error(`这一行没有「${field}」控件`);
  return node;
}

function pickButtonOf(row: HTMLElement): HTMLButtonElement {
  const node = [...row.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('从媒体库选择'),
  );
  if (!node) throw new Error('这一行没有「从媒体库选择」按钮');
  return node as HTMLButtonElement;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('repeater 行里的 media 子字段', () => {
  it('media 子字段渲染地址输入框 + 从媒体库选择按钮', () => {
    const view = mount(teamBlock([{ avatar: '/api/v1/media/old', name: '甲', role: '', link: '' }]));
    const [row] = rows(view);
    const button = pickButtonOf(row);
    expect(button.textContent).toContain('从媒体库选择');
    // 按钮的可访问名带上行号与字段名，读屏时能分清是哪一行。
    expect(button.getAttribute('aria-label')).toContain('第 1 条');
    expect(button.getAttribute('aria-label')).toContain('头像');
    const input = fieldOf(row, '头像') as HTMLInputElement;
    expect(input.value).toBe('/api/v1/media/old');
    // 选择器按需挂载：没点按钮之前不占 DOM，也不去读媒体库。
    expect(document.querySelector('.modal-layer')).toBeNull();
  });

  it('text 子字段仍是普通输入框，且媒体行与文字行各自保持原有结构', () => {
    const view = mount(teamBlock([{ avatar: '', name: '甲', role: '设计', link: '' }]));
    const [row] = rows(view);
    const name = fieldOf(row, '姓名') as HTMLInputElement;
    expect(name.getAttribute('type')).toBe('text');
    expect(name.value).toBe('甲');
    expect(name.closest('.itemlist-field')?.tagName).toBe('LABEL');
    // 媒体行换成 div：行里多了按钮，按钮不能塞进 label。
    expect(fieldOf(row, '头像').closest('.itemlist-field')?.tagName).toBe('DIV');
    // 一行 team 条目只有「选择」和「删除」两个按钮，普通文字字段不会长出选择器。
    const texts = [...row.querySelectorAll('button')].map((button) => button.textContent);
    expect(texts).toEqual(['从媒体库选择', '删除']);
  });

  it('同一时刻只开一个选择器：点第二行时第一行的弹窗关掉', async () => {
    const view = mount(
      teamBlock([
        { avatar: '', name: '甲', role: '', link: '' },
        { avatar: '', name: '乙', role: '', link: '' },
      ]),
    );
    const [first, second] = rows(view);
    await act(async () => {
      pickButtonOf(first).click();
    });
    expect(document.querySelectorAll('.modal-layer').length).toBe(1);
    await act(async () => {
      pickButtonOf(second).click();
    });
    expect(document.querySelectorAll('.modal-layer').length).toBe(1);
  });

  it('选中的地址只写回命中那一行，值仍是纯 URL 字符串', async () => {
    const view = mount(
      teamBlock([
        { avatar: '/api/v1/media/keep', name: '甲', role: '', link: '' },
        { avatar: '', name: '乙', role: '', link: '' },
      ]),
      (props) => {
        latest = props;
      },
      [ASSET],
    );
    const [first, second] = rows(view);
    await act(async () => {
      pickButtonOf(second).click();
    });
    await waitFor(() => !!document.querySelector('.media-picker-item'));
    act(() => {
      (document.querySelector('.media-picker-item') as HTMLButtonElement).click();
    });
    expect(latest.items).toEqual([
      { avatar: '/api/v1/media/keep', name: '甲', role: '', link: '' },
      { avatar: '/api/v1/media/asset-1', name: '乙', role: '', link: '' },
    ]);
    expect(typeof (latest.items as Record<string, string>[])[1].avatar).toBe('string');
    // 选完自动收起。
    expect(document.querySelectorAll('.modal-layer').length).toBe(0);
    expect(rows(view).length).toBe(2);
    expect(pickButtonOf(first).textContent).toContain('从媒体库选择');
  });
});
