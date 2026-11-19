import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ preview: false }));

// 预览判定由测试控制：组件本身不读 iframe，只调用 isPreviewFrame()。
vi.mock('../lib/access', () => ({
  isPreviewFrame: () => state.preview,
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bootRuntimeOnce, ExtensionBoot } from './ExtensionBoot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeRuntime() {
  return { start: vi.fn(async () => undefined) };
}

let root: Root | null = null;

beforeEach(() => {
  state.preview = false;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountBoot(runtime: { start: () => Promise<void> }): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ExtensionBoot, { runtime }));
  });
}

describe('ExtensionBoot', () => {
  it('bootRuntimeOnce 对同一个运行时只启动一次', async () => {
    const runtime = fakeRuntime();
    const first = bootRuntimeOnce(runtime);
    const second = bootRuntimeOnce(runtime);

    expect(first).toBe(second);
    await first;
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('预览 iframe 里不启动，离开预览后同一运行时仍可启动', async () => {
    const runtime = fakeRuntime();
    state.preview = true;
    expect(bootRuntimeOnce(runtime)).toBeNull();
    expect(runtime.start).not.toHaveBeenCalled();

    state.preview = false;
    await bootRuntimeOnce(runtime);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('重复挂载（StrictMode 的双 effect）也只调用一次 start', async () => {
    const runtime = fakeRuntime();
    await mountBoot(runtime);
    await act(async () => root?.unmount());
    root = null;

    await mountBoot(runtime);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('启动失败只 console.warn，不抛出、不影响前台渲染', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = {
      start: vi.fn(async () => {
        throw new Error('manifest 404');
      }),
    };

    await expect(bootRuntimeOnce(runtime)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('boot failed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
});
