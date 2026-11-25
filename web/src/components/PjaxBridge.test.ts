import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PjaxBridge } from './PjaxBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TransitionStub = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

const startViewTransition = vi.fn((callback: () => void): TransitionStub => {
  callback();
  return {
    finished: Promise.resolve(),
    ready: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    skipTransition: () => {},
  };
});

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: startViewTransition,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

async function renderRoute(element: ReturnType<typeof createElement>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/admin'] },
        createElement(PjaxBridge),
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/admin', element }),
          createElement(Route, {
            path: '/admin/storage',
            element: createElement('div', null, 'storage page'),
          }),
        ),
      ),
    );
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

describe('PjaxBridge', () => {
  it('leaves React Router links to the router instead of starting a view transition', async () => {
    await renderRoute(createElement(Link, { to: '/admin/storage' }, 'storage'));

    await click(container.querySelector('a')!);

    expect(container.textContent).toContain('storage page');
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('still takes over raw anchors that no router handler claimed', async () => {
    await renderRoute(createElement('a', { href: '/admin/storage' }, 'storage'));

    await click(container.querySelector('a')!);

    expect(container.textContent).toContain('storage page');
    expect(startViewTransition).toHaveBeenCalledTimes(1);
  });
});
