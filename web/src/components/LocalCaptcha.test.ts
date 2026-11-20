import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendProvider, type Backend } from '../lib/backend';
import type { LocalCaptchaChallenge } from '../types';
import { LocalCaptchaField } from './LocalCaptcha';

/**
 * 本地图形验证组件的交互冒烟测试。
 *
 * 这里不测服务端几何判定（Go 侧已有），只保证三件事在真实 DOM 里成立：三种题型都能
 * 渲染出图、点击位置能换算成图片坐标、点「验证」时提交的答案形状与题型匹配。坐标换算
 * 一旦写错，服务端只会回「答案不正确」，而用户看到的是永远过不去的验证码。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function baseChallenge(overrides: Partial<LocalCaptchaChallenge>): LocalCaptchaChallenge {
  return {
    challenge_id: 'challenge-1',
    kind: 'slider',
    prompt: '',
    expires_at: '2026-11-15T10:10:00Z',
    width: 320,
    height: 200,
    ...overrides,
  };
}

async function mount(challenge: LocalCaptchaChallenge) {
  const verify = vi.fn(async () => ({ token: 'solved-token', expires_at: '2026-11-15T10:10:00Z' }));
  const backend = {
    captchaLocalChallenge: vi.fn(async () => challenge),
    captchaLocalVerify: verify,
  } as unknown as Backend;
  const onToken = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(BackendProvider, {
        backend,
        children: createElement(LocalCaptchaField, {
          scene: 'login',
          resetKey: 0,
          onToken,
        }),
      }),
    );
  });
  return { backend, verify, onToken };
}

function stubRect(element: Element, width: number, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }),
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} not found`);
  return found as HTMLButtonElement;
}

async function click(element: Element, clientX: number, clientY: number) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
  });
}

describe('LocalCaptchaField', () => {
  it('滑块题渲染场景、拼图与滑块控件', async () => {
    await mount(
      baseChallenge({
        kind: 'slider',
        width: 320,
        height: 180,
        background: 'data:image/png;base64,background',
        piece: 'data:image/png;base64,piece',
        piece_size: 52,
        piece_top: 40,
        max_offset: 268,
      }),
    );

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toContain('background');
    expect(images[1].getAttribute('src')).toContain('piece');
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('点击题把点击位置换算成图片坐标并提交全部点', async () => {
    const { verify } = await mount(
      baseChallenge({
        kind: 'click',
        width: 320,
        height: 200,
        image: 'data:image/png;base64,picture',
        target_count: 2,
      }),
    );

    const picture = container.querySelector('img');
    expect(picture).not.toBeNull();
    stubRect(picture as Element, 160, 100);
    // 图片显示尺寸是原始的一半：点 (80,50) 与 (160,100) 应提交为 (160,100)/(320,200)。
    await click(picture as Element, 80, 50);
    await click(picture as Element, 160, 100);

    expect(container.querySelectorAll('.captcha-marker')).toHaveLength(2);
    const submit = button('验证');
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.click();
    });
    expect(verify).toHaveBeenCalledWith({
      challenge_id: 'challenge-1',
      scene: 'login',
      answer: {
        points: [
          { x: 160, y: 100 },
          { x: 320, y: 200 },
        ],
      },
    });
  });

  it('选择题把点击换算成格子序号并提交', async () => {
    const { verify } = await mount(
      baseChallenge({
        kind: 'select',
        width: 288,
        height: 288,
        image: 'data:image/png;base64,grid',
        rows: 3,
        cols: 3,
        target_count: 2,
      }),
    );

    const picture = container.querySelector('img');
    expect(picture).not.toBeNull();
    stubRect(picture as Element, 288, 288);
    // 正中央是第 4 格（行优先），再点左上角第 0 格。
    await click(picture as Element, 144, 144);
    await click(picture as Element, 10, 10);

    expect(container.querySelectorAll('.captcha-cell.is-selected')).toHaveLength(2);
    const submit = button('验证');
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.click();
    });
    expect(verify).toHaveBeenCalledWith({
      challenge_id: 'challenge-1',
      scene: 'login',
      answer: { tiles: [0, 4] },
    });
  });

  it('进度条随已选数量更新，并带可读的 aria 数值', async () => {
    await mount(
      baseChallenge({
        kind: 'click',
        width: 320,
        height: 200,
        image: 'data:image/png;base64,picture',
        target_count: 3,
      }),
    );

    const picture = container.querySelector('img');
    expect(picture).not.toBeNull();
    stubRect(picture as Element, 320, 200);

    const progress = () =>
      container.querySelector('.captcha-progress')?.getAttribute('aria-valuenow');
    expect(progress()).toBe('0');
    expect(container.querySelector('.captcha-progress-fill')).not.toBeNull();

    await click(picture as Element, 80, 50);
    expect(progress()).toBe('1');
  });

  it('卡片头部展示题型提示，验证通过后切换为已完成状态', async () => {
    const { verify, onToken } = await mount(
      baseChallenge({
        kind: 'slider',
        width: 320,
        height: 180,
        background: 'data:image/png;base64,background',
        piece: 'data:image/png;base64,piece',
        piece_size: 52,
        piece_top: 40,
        max_offset: 268,
      }),
    );

    // 头部属于卡片结构：图标 + 标题 + 题型提示。这里只断言「存在且非空」，
    // 具体中文/英文文案由 i18n 覆盖测试守，避免改一句话就弄断交互测试。
    expect(container.querySelector('.captcha-field')?.getAttribute('data-state')).toBe('challenge');
    const head = container.querySelector('.captcha-head');
    expect(head).not.toBeNull();
    expect(head?.querySelector('.captcha-head-icon svg')).not.toBeNull();
    expect(head?.querySelector('.captcha-head-title')?.textContent?.trim()).toBeTruthy();
    expect(head?.querySelector('.captcha-head-hint')?.textContent?.trim()).toBeTruthy();

    await act(async () => {
      button('验证').click();
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('solved-token');

    // 通过后同一张卡片切到已完成态：出现完成徽标与成功提示，题目本体收起。
    expect(container.querySelector('.captcha-field')?.getAttribute('data-state')).toBe('solved');
    expect(container.querySelector('.captcha-head .badge')).not.toBeNull();
    expect(container.querySelector('.captcha-done')).not.toBeNull();
    expect(container.querySelector('.captcha-stage')).toBeNull();
  });
});
