import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MediaQuotaBytes } from '../types';
import { MediaQuotaField } from './MediaQuotaField';

/**
 * 站点媒体额度输入框：MB ↔ 字节换算、自动保存与非法输入拦截。
 *
 * 组件只负责草稿和防抖，真正的站点 PATCH 由页面传入的 `onSave` 完成。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

function renderField(
  value: MediaQuotaBytes | undefined,
  onSave: (next: MediaQuotaBytes) => Promise<void>,
): void {
  act(() => {
    root = createRoot(container);
    root.render(createElement(MediaQuotaField, { value, onSave }));
  });
}

function quotaInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="本站媒体额度（MB）"]');
  if (!input) throw new Error('找不到媒体额度输入框');
  return input;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 等过自动保存的防抖窗口，并让保存后的状态更新跑完。 */
async function waitPastSave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

describe('MediaQuotaField', () => {
  it('shows the saved byte value in MB and explains the unit', () => {
    renderField(1572864, vi.fn(async () => undefined));

    expect(quotaInput().value).toBe('1.5');
    expect(container.textContent).toContain(
      '媒体额度单位为 MB（1 MB = 1024 × 1024 字节）；留空继承部署默认，0 表示无限。',
    );
  });

  it('saves a decimal MB input as whole bytes after the debounce', async () => {
    const onSave = vi.fn(async () => undefined);
    renderField(null, onSave);

    act(() => {
      setInputValue(quotaInput(), '1.5');
    });
    expect(onSave).not.toHaveBeenCalled();

    await waitPastSave();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(1572864);
    expect(container.textContent).toContain('已自动保存');
  });

  it('clears an explicit quota to the deployment default when the input is emptied', async () => {
    const onSave = vi.fn(async () => undefined);
    renderField(1572864, onSave);

    act(() => {
      setInputValue(quotaInput(), '');
    });

    await waitPastSave();
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('blocks invalid input and retries once the value is valid again', async () => {
    const onSave = vi.fn(async () => undefined);
    renderField(null, onSave);

    act(() => {
      setInputValue(quotaInput(), '-1');
    });
    await waitPastSave();

    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      '媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。',
    );

    act(() => {
      setInputValue(quotaInput(), '2');
    });
    await waitPastSave();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(2097152);
    expect(container.textContent ?? '').not.toContain(
      '媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。',
    );
  });

  it('follows an external quota change while the field is untouched', () => {
    renderField(null, vi.fn(async () => undefined));
    expect(quotaInput().value).toBe('');

    act(() => {
      root?.render(createElement(MediaQuotaField, { value: 1048576, onSave: vi.fn(async () => undefined) }));
    });

    expect(quotaInput().value).toBe('1');
  });
});
