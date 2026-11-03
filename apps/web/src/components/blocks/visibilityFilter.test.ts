import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, Me, ScreenLayout } from '../../types';
import { createBlock } from '../../lib/blocks';

/**
 * `visible` 必须真的接进渲染链，而不只是 `isVisibleAt` 这个纯函数对。
 *
 * 只测纯函数会漏掉三件事：根级区块没被过滤、子区块（容器里的）没被过滤、
 * 角色没有从登录态接进来。这里用真实渲染把三件事一起钉住。
 */

let me: Me | null = null;
vi.mock('../../lib/session', () => ({
  useAuth: () => ({
    me,
    config: {},
    status: me ? 'ready' : 'anonymous',
    session: null,
    site: null,
    unread: 0,
  }),
}));

import { ScreenRenderer } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(layout: ScreenLayout) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(ScreenRenderer, { layout }));
  });
  return host;
}

function renderedIds(el: HTMLElement) {
  return [...el.querySelectorAll('[data-pp-block]')].map((node) => node.getAttribute('data-pp-block'));
}

function block(id: string, patch: Partial<BlockInstance> = {}) {
  return createBlock('text', { id, ...patch });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  me = null;
  // 恢复桌面宽度，避免影响同进程里的其他测试。
  window.innerWidth = 1280;
});

// happy-dom 默认视口够宽，`useViewportDevice` 会判成 desktop。
window.innerWidth = 1280;

describe('渲染入口上的条件显示', () => {
  it('角色不符的根级区块不渲染', () => {
    me = null; // 访客
    const host = mount({
      blocks: [block('always'), block('members-only', { visible: { roles: ['member'] } })],
    });

    expect(renderedIds(host)).toEqual(['always']);
  });

  it('登录后的普通用户能看见 members 区块', () => {
    me = { user: { id: 'u1' } as Me['user'], role: 'member', site_id: 's1' };
    const host = mount({
      blocks: [block('always'), block('members-only', { visible: { roles: ['member'] } })],
    });

    expect(renderedIds(host)).toContain('members-only');
  });

  it('容器里的子区块服从同一条规则', () => {
    me = null;
    const host = mount({
      blocks: [
        createBlock('container', {
          id: 'box',
          children: [
            block('kid-plain'),
            block('kid-mobile-only', { visible: { devices: ['mobile'] } }),
          ],
        }),
      ],
    });

    const ids = renderedIds(host);
    expect(ids).toContain('kid-plain');
    expect(ids).not.toContain('kid-mobile-only');
  });

  it('分栏列里的子区块同样服从角色条件：访客看不到 members 区块', () => {
    me = null;
    const host = mount({
      blocks: [
        createBlock('columns', {
          id: 'cols',
          props: { columns: 2, gap: 'normal' },
          children: [
            block('col-plain', { column: 1 }),
            block('col-members', { column: 2, visible: { roles: ['member'] } }),
          ],
        }),
      ],
    });

    const ids = renderedIds(host);
    expect(ids).toContain('col-plain');
    expect(ids).not.toContain('col-members');
  });

  it('分栏列里的 members 区块对登录会员可见', () => {
    me = { user: { id: 'u1' } as Me['user'], role: 'member', site_id: 's1' };
    const host = mount({
      blocks: [
        createBlock('columns', {
          id: 'cols',
          props: { columns: 2, gap: 'normal' },
          children: [
            block('col-plain', { column: 1 }),
            block('col-members', { column: 2, visible: { roles: ['member'] } }),
          ],
        }),
      ],
    });

    expect(renderedIds(host)).toContain('col-members');
  });

  it('条件全部满足不了时整屏为空，不留外壳', () => {
    me = null;
    const host = mount({ blocks: [block('members-only', { visible: { roles: ['member'] } })] });

    expect(host.querySelector('.pp-block')).toBeNull();
  });
});
