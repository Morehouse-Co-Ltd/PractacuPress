import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/i18n', () => ({
  useT: () => (text: string) => text,
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AutoSaveStatus } from './AutoSaveStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = '';
});

describe('AutoSaveStatus', () => {
  it('只让一个状态条成为 live region，避免屏幕阅读器重复播报', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          'div',
          null,
          createElement(AutoSaveStatus, { state: 'saved' }),
          createElement(AutoSaveStatus, { state: 'saved', live: false }),
        ),
      );
    });

    expect(container.querySelectorAll('.autosave-status')).toHaveLength(2);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live="off"]')).toHaveLength(1);
    expect(container.textContent).toContain('已自动保存');
  });
});
