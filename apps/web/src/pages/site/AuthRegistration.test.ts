import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { WebConfig } from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { ApiError, fallbackProblem } from '../../lib/api';
import { AuthPage } from './Auth';

/**
 * O-3 注册关闭在注册页的表现：
 * - 已知关闭（访客引导 setup/status 的 registration_open=false）→ 直接显示关闭提示卡；
 * - 未知关闭（旧客户端/已装浏览器）→ 表单可提交，服务端 403 registration_closed 时
 *   显示「本站暂未开放注册」而不是 problem 原文。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function configOf(patch: Partial<WebConfig> = {}): WebConfig {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: 'http://api.test',
    site_id: 'site_1',
    database: 'sqlite',
    created_at: '2026-11-02T00:00:00Z',
    docs_url: 'http://api.test/api/v1/docs',
    ...patch,
  };
}

function anonymousBackend(overrides: Partial<Backend> = {}): Backend {
  const base = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => {
      throw new ApiError({ ...fallbackProblem(401), code: 'unauthenticated' });
    },
    passwordResetPolicy: async () => ({ enabled: false }),
    register: async () => {
      throw new ApiError({
        ...fallbackProblem(403),
        code: 'permission_denied',
        details: { reason: 'registration_closed' },
      });
    },
  };
  return { ...base, ...overrides } as unknown as Backend;
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  localStorage.clear();
});

async function renderRegister(config: WebConfig, backend: Backend): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ToastProvider, null,
        createElement(BackendProvider, {
          backend,
          children: createElement(AuthProvider, {
            config,
            backend,
            onConfigChange: () => undefined,
            children: createElement(MemoryRouter, {
              initialEntries: ['/register'],
              children: createElement(AuthPage, { mode: 'register' }),
            }),
          }),
        }),
      ),
    );
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error('等待界面进入预期状态超时');
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('注册页在关闭注册时的提示', () => {
  it('shows the closed card when the visitor bootstrap already knows registration is off', async () => {
    const config = configOf({
      visitor: true,
      visitor_site_name: '安静编辑部',
      visitor_registration_open: false,
    });
    await renderRegister(config, anonymousBackend());

    await waitFor(() => container.textContent?.includes('本站暂未开放注册') === true);

    expect(container.textContent).toContain('本站暂未开放注册');
    expect(container.textContent).toContain('安静编辑部');
    expect(container.textContent).not.toContain('创建账户');
  });

  it('maps the server 403 registration_closed rejection to a friendly message', async () => {
    await renderRegister(configOf(), anonymousBackend());
    // 还没拿到关闭状态：注册表单照常渲染。
    await waitFor(() => !!container.querySelector('#auth-email'));

    const email = container.querySelector<HTMLInputElement>('#auth-email')!;
    const name = container.querySelector<HTMLInputElement>('#auth-name')!;
    const password = container.querySelector<HTMLInputElement>('#auth-password')!;
    const confirm = container.querySelector<HTMLInputElement>('#auth-confirm')!;
    const form = container.querySelector('form')!;

    await act(async () => {
      setValue(email, 'reader@example.com');
      setValue(name, '读者');
      setValue(password, 'long-password-1');
      setValue(confirm, 'long-password-1');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => container.textContent?.includes('本站暂未开放注册') === true);

    expect(container.textContent).toContain('本站暂未开放注册');
    // 不应把服务端 problem 的原始文案直接抛给访客。
    expect(container.textContent).not.toContain('permission_denied');
  });
});
