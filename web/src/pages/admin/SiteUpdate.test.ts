import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 站点更新页的渲染与交互。
 *
 * 这一页不能只是“设置表单”：服务器地址必须是下拉栏、端口输入必须消失、手动更新
 * 必须真的发起检查并在结果里显示远端版本。这里用稳定的假会话与假的更新客户端，
 * 把这几条钉在测试里。
 */

const state = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  checkForUpdate: vi.fn(),
  applyUpdateFromDir: vi.fn(),
  config: {
    mode: 'demo',
    update: {
      mode: 'manual',
      channel: 'stable',
      frequency: 'startup',
      server_url:
        'https://raw.githubusercontent.com/practacu/practacu-press/main/web/public/version.json',
    },
  },
  push: vi.fn(),
}));

vi.mock('../../lib/session', () => ({
  useAuth: () => ({
    config: state.config,
    site: { name: 'Practacu' },
    updateConfig: state.updateConfig,
    status: 'ready',
    me: { role: 'platform_admin' },
  }),
}));

vi.mock('../../lib/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, canRole: () => true, personal: false }),
}));

vi.mock('../../lib/toast', () => ({
  useToast: () => ({ push: state.push }),
  useOptionalToast: () => null,
  ToastProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('../../lib/updateClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/updateClient')>();
  return {
    ...actual,
    checkForUpdate: (...args: unknown[]) => state.checkForUpdate(...args),
    applyUpdateFromDir: (...args: unknown[]) => state.applyUpdateFromDir(...args),
  };
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SiteUpdatePage } from './SiteUpdate';
import { UPDATE_SERVERS } from '../../lib/siteUpdate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  state.updateConfig.mockClear();
  state.checkForUpdate.mockReset();
  state.applyUpdateFromDir.mockReset();
  state.push.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(MemoryRouter, null, createElement(SiteUpdatePage, null)),
    );
  });
  return container;
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const found = buttons.find((button) => (button.textContent ?? '').trim() === label);
  if (!found) throw new Error(`没有找到按钮：${label}`);
  return found as HTMLButtonElement;
}

/** 走 React 认识的那条路写入受控输入：原生 setter + input 事件。 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const remote = {
  title: 'Practacu Press',
  describe: '新的版本说明。',
  version: '0.2.0',
  style: 'stable' as const,
};

describe('站点更新页', () => {
  it('把服务器地址做成下拉栏，并且不再有端口输入', async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('#site-update-server');
    expect(select).not.toBeNull();
    expect(select?.tagName).toBe('SELECT');
    const values = Array.from(select?.querySelectorAll('option') ?? []).map(
      (option) => option.value,
    );
    expect(values).toEqual(UPDATE_SERVERS.map((item) => item.url));
    expect(container.querySelector('#site-update-port')).toBeNull();
    expect(container.textContent ?? '').not.toContain('默认端口');
  });

  it('有手动更新与自动更新两种方式，默认手动', async () => {
    await render();
    const mode = container.querySelector<HTMLSelectElement>('#site-update-mode');
    expect(mode?.value).toBe('manual');
    const labels = Array.from(mode?.querySelectorAll('option') ?? []).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual(['手动更新', '自动更新']);
    expect(container.textContent ?? '').toContain('手动更新');
    // 手动模式下检查频率被禁用。
    expect(container.querySelector<HTMLSelectElement>('#site-update-frequency')?.disabled).toBe(
      true,
    );
  });

  it('检查更新会请求服务端并显示远端版本与说明', async () => {
    state.checkForUpdate.mockResolvedValue({
      local: { title: 'Practacu Press', describe: '本地', version: '0.1.1-beta', style: 'beta' },
      remote,
      source: state.config.update.server_url,
      checked_at: '2026-11-15T04:00:00Z',
      server_side: true,
    });
    await render();
    await act(async () => {
      buttonByText('检查更新').click();
    });

    expect(state.checkForUpdate).toHaveBeenCalledTimes(1);
    const args = state.checkForUpdate.mock.calls[0][0] as { server_url: string };
    expect(args.server_url).toBe(UPDATE_SERVERS[0].url);
    const result = container.querySelector('[data-site-update-result]');
    expect(result).not.toBeNull();
    expect(result?.textContent ?? '').toContain('v0.2.0');
    expect(result?.textContent ?? '').toContain('新的版本说明。');
    expect(result?.textContent ?? '').toContain('由本机服务端读取清单');
    // 检查后把时间与远端版本写回设置。
    expect(state.updateConfig).toHaveBeenCalled();
    const patch = state.updateConfig.mock.calls.at(-1)?.[0] as {
      update: { last_checked_at?: string; last_remote_version?: string };
    };
    expect(patch.update.last_checked_at).toBe('2026-11-15T04:00:00Z');
    expect(patch.update.last_remote_version).toBe('0.2.0');
  });

  it('切换更新方式后保存会写回配置', async () => {
    await render();
    const mode = container.querySelector<HTMLSelectElement>('#site-update-mode');
    await act(async () => {
      if (mode) {
        mode.value = 'auto';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(container.querySelector<HTMLSelectElement>('#site-update-frequency')?.disabled).toBe(
      false,
    );
    await act(async () => {
      buttonByText('保存设置').click();
    });
    expect(state.updateConfig).toHaveBeenCalledTimes(1);
    const patch = state.updateConfig.mock.calls[0][0] as { update: { mode: string } };
    expect(patch.update.mode).toBe('auto');
  });

  it('手动更新：把构建目录交给服务端，并给出可重新载入的提示', async () => {
    state.applyUpdateFromDir.mockResolvedValue({
      version: '0.2.0',
      previous: '0.1.1-beta',
      active: 'dist-0.2.0',
    });
    await render();
    const input = container.querySelector<HTMLInputElement>('#site-update-apply-dir');
    expect(input).not.toBeNull();
    await act(async () => {
      if (input) typeInto(input, 'C:\\builds\\dist-0.2.0');
    });
    await act(async () => {
      buttonByText('立即切换').click();
    });
    expect(state.applyUpdateFromDir).toHaveBeenCalledWith('C:\\builds\\dist-0.2.0');
    expect(container.textContent ?? '').toContain('新版本已经就位');
    expect(container.textContent ?? '').toContain('v0.2.0');
    expect(buttonByText('重新载入到新版本')).not.toBeNull();
  });
});
