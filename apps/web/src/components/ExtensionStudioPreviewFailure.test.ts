import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { CustomExtension } from '../types';
import { createExtension } from '../lib/extensions';
import { ToastProvider } from '../lib/toast';
import { ExtensionStudio } from './ExtensionStudio';

/**
 * 预览失败隔离：扩展文档拼装抛错时，
 *
 * - 只有预览区回退，工坊（表单、代码框、保存按钮）保持可用；
 * - 失败会弹一条 toast，但不会被加载兜底重复刷屏；
 * - 仍然能把改动保存出去——保存不依赖 iframe 是否跑起来。
 *
 * 用 `vi.mock` 让 `buildExtensionDocument` 必抛，模拟沙箱文档拼装失败。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/extensions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/extensions')>();
  return {
    ...actual,
    buildExtensionDocument: () => {
      throw new Error('preview boom');
    },
  };
});

const THEME = { background: '#ffffff', ink: '#14140f', accent: '#1f5c4a', font: 'serif' as const };

function savedExtension(): CustomExtension {
  return createExtension({
    id: 'ext_preview_fail',
    name: '作者卡',
    version: '1.0.0',
    author: '站长',
    description: '文末名片',
    enabled: true,
    slots: ['article_bottom'],
    pages: ['all'],
    permissions: [],
    html: '<p>old</p>',
    css: 'p{color:red}',
    js: '',
  });
}

let container: HTMLDivElement;
let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React 会把被错误边界接住的异常打到 console.error；这是本用例的预期行为。
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  document.body.innerHTML = '';
  consoleError.mockRestore();
  vi.restoreAllMocks();
});

function typeInto(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`没有找到按钮：${label}`);
  await act(async () => {
    button.click();
  });
}

describe('扩展工坊：预览失败', () => {
  it('只回退预览并提示一次，表单与保存仍然可用', async () => {
    const saved = savedExtension();
    const onSave = vi.fn((draft: CustomExtension) => draft);

    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            ToastProvider,
            null,
            createElement(ExtensionStudio, {
              saved,
              theme: THEME,
              onClose: () => {},
              onSave,
            }),
          ),
        ),
      );
    });

    // 表单没有被错误边界连带卸载。
    const field = document.querySelector<HTMLTextAreaElement>('textarea.ppe-code');
    expect(field).not.toBeNull();
    expect(document.querySelector('.ppe-studio')).not.toBeNull();

    // 预览区退到兜底提示，并给出重试按钮。
    expect(document.querySelector('.ppe-studio-preview-stage')?.textContent).toContain('预览失败');
    expect(document.body.textContent).toContain('扩展预览失败');

    // 预览失败不挡保存：改动仍然能提交。
    await act(async () => {
      typeInto(field as HTMLTextAreaElement, '<p>changed anyway</p>');
    });
    await clickButton('更新');

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].html).toBe('<p>changed anyway</p>');
  });
});
