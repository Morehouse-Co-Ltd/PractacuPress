import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { CustomExtension } from '../types';
import { buildExtensionForSave } from '../lib/extensionDraft';
import { createExtension } from '../lib/extensions';
import { ToastProvider } from '../lib/toast';
import { ExtensionStudio, type ExtensionStudioProps } from './ExtensionStudio';

/**
 * 扩展工坊的交互回归：
 *
 * - 改代码 / 勾槽位只更新草稿，点保存调用 `onSave` 一次，工坊不重建；
 * - Ctrl+S 保存后焦点与光标仍留在代码框里（不整页刷新、不重置编辑区）；
 * - 新建时必须先填名称，不会写出空清单。
 *
 * 用真实的 happy-dom + react-dom 渲染（与 AppBoot.test 同一套方式），不引入
 * 额外的测试库。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THEME = { background: '#ffffff', ink: '#14140f', accent: '#1f5c4a', font: 'serif' as const };

function savedExtension(overrides: Partial<CustomExtension> = {}): CustomExtension {
  return {
    ...createExtension({
      id: 'ext_studio',
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
    }),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
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
});

function studio(props: ExtensionStudioProps): ReactElement {
  return createElement(
    MemoryRouter,
    null,
    createElement(ToastProvider, null, createElement(ExtensionStudio, props)),
  );
}

async function render(props: ExtensionStudioProps): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(studio(props));
  });
}

function htmlField(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>('textarea.ppe-code');
  if (!field) throw new Error('没有找到 HTML 代码框');
  return field;
}

/** 绕过 React 的 value tracker，模拟真实输入。 */
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

describe('扩展工坊', () => {
  it('改代码后点保存：只调用一次 onSave，编辑区节点不重建', async () => {
    const saved = savedExtension();
    const onSave = vi.fn((draft: CustomExtension) => buildExtensionForSave(draft, saved));
    const onClose = vi.fn();

    await render({ saved, theme: THEME, onClose, onSave });

    const field = htmlField();
    await act(async () => {
      typeInto(field, '<p>new</p>');
    });

    await clickButton('更新');

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].html).toBe('<p>new</p>');
    // 同一个 textarea 节点还在原地：工坊没有被卸载重建（选中项、滚动与光标都不会丢）。
    expect(htmlField()).toBe(field);
    expect(field.value).toBe('<p>new</p>');
    expect(document.querySelector('.ppe-studio')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Ctrl+S 保存后焦点与光标仍留在代码框里', async () => {
    const saved = savedExtension();
    const onSave = vi.fn((draft: CustomExtension) => buildExtensionForSave(draft, saved));

    await render({ saved, theme: THEME, onClose: () => {}, onSave });

    const field = htmlField();
    await act(async () => {
      field.focus();
      typeInto(field, '<p>new</p>');
      field.setSelectionRange(4, 4);
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(4);
    expect(field.value).toBe('<p>new</p>');
  });

  it('勾选挂载位置后保存，草稿带上新的槽位', async () => {
    const saved = savedExtension();
    const onSave = vi.fn((draft: CustomExtension) => buildExtensionForSave(draft, saved));

    await render({ saved, theme: THEME, onClose: () => {}, onSave });

    const chip = Array.from(document.querySelectorAll<HTMLLabelElement>('.ppe-chip')).find(
      (item) => item.textContent?.trim() === '悬浮窗',
    );
    const checkbox = chip?.querySelector<HTMLInputElement>('input');
    if (!checkbox) throw new Error('没有找到「悬浮窗」勾选项');
    await act(async () => {
      checkbox.click();
    });

    await clickButton('更新');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].slots).toEqual(['article_bottom', 'floating']);
  });

  it('已有内容时插入示例模板先确认，避免覆盖掉正在写的代码', async () => {
    const saved = savedExtension();
    await render({ saved, theme: THEME, onClose: () => {}, onSave: vi.fn() });

    // saved 里已经有 HTML，点模板不会立刻替换，而是先问一句。
    await clickButton('文末作者卡');
    expect(document.body.textContent).toContain('示例模板会覆盖当前的 HTML / CSS / JS，继续吗？');
    expect(htmlField().value).toBe('<p>old</p>');

    await clickButton('继续');
    expect(htmlField().value).toContain('ppe-author');
  });

  it('新建扩展没填名称时拦住保存', async () => {
    const onSave = vi.fn();
    await render({ saved: null, theme: THEME, onClose: () => {}, onSave });

    await clickButton('保存为我的扩展');

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请先填写扩展名称');
  });
});
