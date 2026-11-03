import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, BlockProps } from '../types';
import formCss from '../styles.css?raw';

/**
 * P3 联系表单（`contact-form`）。
 *
 * 这个测试钉住五件事：
 * 1. 校验规则与服务端同口径：留言必填、长度按字符算，姓名 / 邮箱按字节算；
 * 2. 蜜罐被填时**不调用接口**——判定在提交之前；
 * 3. 注册表定义：分组、变体、defaults 与 schema 一致、归一化幂等；
 * 4. 渲染器真的注册进了生产用的 `RENDERERS`；
 * 5. 三态与两条路径：真实后端提交一次、失败保留用户输入、演示模式不发请求。
 */

vi.mock('./session', () => ({
  useAuth: () => ({
    me: null,
    config: {},
    status: 'anonymous',
    session: null,
    site: { id: 'site_main', slug: 'main', name: '示例站点' },
    unread: 0,
  }),
}));

/**
 * 演示 / 真实两种后端的替身：只实现联系表单用到的 `contactSite`。
 *
 * 后端对象必须**稳定**（每次渲染返回同一个引用），渲染器把它放进 `useBackend`，
 * 每次新建对象会让状态闭包失效。
 */
const fake = vi.hoisted(() => {
  const state = {
    demo: false,
    calls: [] as { siteId: string; body: Record<string, string> }[],
    fail: false,
  };
  const backend = {
    contactSite: async (siteId: string, body: Record<string, string>) => {
      state.calls.push({ siteId, body });
      if (state.fail) throw new Error('boom');
    },
  };
  return { state, backend };
});

vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend')>();
  return {
    ...actual,
    useBackend: () => fake.backend,
    isDemo: () => fake.state.demo,
  };
});

import {
  CONTACT_COOLDOWN_MS,
  CONTACT_LIMITS,
  cooldownRemainingMs,
  contactPayload,
  honeypotTripped,
  looksLikeEmail,
  utf8Length,
  validateContact,
} from './contactForm';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';
import { BLOCK_RENDERERS } from '../components/blocks/index';
import { FORM_RENDERERS } from '../components/blocks/FormBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPE = 'contact-form';

/** 区块默认显示的两个字段：多数用例都用它。 */
const ALL_FIELDS = { showName: true, showEmail: true };

function draft(patch: Partial<Record<'name' | 'email' | 'message' | 'website', string>> = {}) {
  return { name: '林可', email: 'linke@example.com', message: '想问问封面是谁拍的？', ...patch };
}

/* ---------------- 纯函数 ---------------- */

describe('utf8Length', () => {
  it('ASCII 一字节、汉字三字节、emoji 四字节，与 Go 的 len(string) 同口径', () => {
    expect(utf8Length('ok')).toBe(2);
    expect(utf8Length('站点')).toBe(6);
    expect(utf8Length('📮')).toBe(4);
    expect(utf8Length('')).toBe(0);
  });
});

describe('validateContact', () => {
  it('合法填写没有问题', () => {
    expect(validateContact(draft(), ALL_FIELDS)).toBeNull();
  });

  it('空留言与只有空白的留言都不放行', () => {
    expect(validateContact(draft({ message: '' }), ALL_FIELDS)).toBe('message_required');
    expect(validateContact(draft({ message: '   \n ' }), ALL_FIELDS)).toBe('message_required');
  });

  it('留言按字符算：2000 个汉字通过，2001 个被拦', () => {
    expect(
      validateContact(draft({ message: '长'.repeat(CONTACT_LIMITS.message) }), ALL_FIELDS),
    ).toBeNull();
    expect(
      validateContact(draft({ message: '长'.repeat(CONTACT_LIMITS.message + 1) }), ALL_FIELDS),
    ).toBe('message_too_long');
  });

  it('邮箱必须含 @，两边不能是空的', () => {
    expect(validateContact(draft({ email: 'not-an-address' }), ALL_FIELDS)).toBe('email_invalid');
    expect(validateContact(draft({ email: '@example.com' }), ALL_FIELDS)).toBe('email_invalid');
    expect(validateContact(draft({ email: 'linke@' }), ALL_FIELDS)).toBe('email_invalid');
    expect(validateContact(draft({ email: 'linke @example.com' }), ALL_FIELDS)).toBe('email_invalid');
  });

  it('邮箱可以不填', () => {
    expect(validateContact(draft({ email: '' }), ALL_FIELDS)).toBeNull();
  });

  it('姓名与邮箱按字节算，与通知 payload 的存法一致', () => {
    // 27 个汉字 = 81 字节，超过 80 的上限，即便字符数只有 27。
    expect(validateContact(draft({ name: '名'.repeat(27) }), ALL_FIELDS)).toBe('name_too_long');
    expect(validateContact(draft({ name: '名'.repeat(26) }), ALL_FIELDS)).toBeNull();

    const longEmail = `${'a'.repeat(CONTACT_LIMITS.email)}@example.com`;
    expect(validateContact(draft({ email: longEmail }), ALL_FIELDS)).toBe('email_too_long');
  });

  it('藏起来的字段不参与校验', () => {
    const hidden = { showName: false, showEmail: false };
    expect(validateContact(draft({ name: '名'.repeat(40), email: 'nope' }), hidden)).toBeNull();
  });
});

describe('looksLikeEmail', () => {
  it('只认「含 @ 且两边都不空、没有空白」', () => {
    expect(looksLikeEmail('a@b')).toBe(true);
    expect(looksLikeEmail('a@b.c')).toBe(true);
    expect(looksLikeEmail('a@')).toBe(false);
    expect(looksLikeEmail('@b')).toBe(false);
    expect(looksLikeEmail('a b@c')).toBe(false);
  });
});

describe('honeypotTripped', () => {
  it('空值与空白不算，任何非空值都算', () => {
    expect(honeypotTripped(draft())).toBe(false);
    expect(honeypotTripped(draft({ website: '   ' }))).toBe(false);
    expect(honeypotTripped(draft({ website: 'https://spam.example' }))).toBe(true);
  });
});

describe('contactPayload', () => {
  it('去掉首尾空白；藏起来的字段不发', () => {
    const hidden = { showName: false, showEmail: true };
    expect(contactPayload(draft({ name: '  林可 ', message: ' 你好 ' }), hidden)).toEqual({
      name: '',
      email: 'linke@example.com',
      message: '你好',
      website: '',
    });
  });
});

describe('cooldownRemainingMs', () => {
  it('没发过就没有冷却', () => {
    expect(cooldownRemainingMs(null, 1_000)).toBe(0);
  });

  it('刚发完剩满一分钟，过一半剩一半，超时归零', () => {
    expect(cooldownRemainingMs(1_000, 1_000)).toBe(CONTACT_COOLDOWN_MS);
    expect(cooldownRemainingMs(1_000, 1_000 + 30_000)).toBe(30_000);
    expect(cooldownRemainingMs(1_000, 1_000 + CONTACT_COOLDOWN_MS)).toBe(0);
  });
});

/* ---------------- 注册表 ---------------- */

function field(key: string) {
  return blockDef(TYPE)?.schema.find((item) => item.key === key);
}

describe('注册表定义', () => {
  it('注册在内容组，经典与夜航都能用', () => {
    const def = blockDef(TYPE);
    expect(def).toBeTruthy();
    expect(def?.group).toBe('content');
    expect(def?.variants).toEqual(['classic', 'bento']);
    expect(def?.name.trim()).not.toBe('');
    expect(def?.description.trim()).not.toBe('');
  });

  it('defaults 是约定的初始内容，且每个键都声明在 schema 里', () => {
    const defaults = blockDef(TYPE)?.defaults ?? {};
    expect(defaults).toEqual({
      heading: '',
      intro: '',
      submit_label: '',
      success_text: '',
      show_name: true,
      show_email: true,
    });
    const declared = new Set((blockDef(TYPE)?.schema ?? []).map((item) => item.key));
    expect(Object.keys(defaults).filter((key) => !declared.has(key))).toEqual([]);
  });

  it('defaults 经过归一化后原样保留', () => {
    const created = createBlock(TYPE).props;
    expect(normalizeBlockProps(TYPE, created)).toEqual(created);
  });

  it('说明是 richtext，两个开关是 toggle', () => {
    expect(field('intro')?.type).toBe('richtext');
    expect(field('show_name')?.type).toBe('toggle');
    expect(field('show_email')?.type).toBe('toggle');
  });
});

/* ---------------- 渲染 ---------------- */

function mk(props: BlockProps): BlockInstance {
  return { id: TYPE, type: TYPE, title: TYPE, props, animation: 'none', hidden: false };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: BlockProps): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const Renderer = FORM_RENDERERS[TYPE];
  await act(async () => {
    root?.render(createElement(Renderer, { block: mk(props) }));
  });
  return host;
}

/** React 受控输入必须走原生 setter，再派发 input 事件。 */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(el: HTMLElement) {
  const form = el.querySelector('form');
  expect(form).toBeTruthy();
  await act(async () => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function fieldOf(el: HTMLElement, name: string) {
  return el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
}

beforeEach(() => {
  fake.state.demo = false;
  fake.state.calls = [];
  fake.state.fail = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('渲染器注册', () => {
  it('生产 RENDERERS 里能找到，且 FORM_RENDERERS 只有这一条', () => {
    expect(typeof BLOCK_RENDERERS[TYPE]).toBe('function');
    expect(Object.keys(FORM_RENDERERS)).toEqual([TYPE]);
  });
});

describe('表单渲染', () => {
  it('标题与说明只在填了的时候出现，蜜罐对读屏隐藏', async () => {
    const el = await mount({ heading: '写信给我', intro: '**只谈正事**' });
    expect(el.querySelector('.pp-contact-heading')?.textContent).toBe('写信给我');
    expect(el.querySelector('.pp-contact-intro')?.textContent).toContain('只谈正事');
    const honeypot = el.querySelector('.pp-contact-honeypot');
    expect(honeypot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('关掉 switch 就不渲染对应字段', async () => {
    const el = await mount({ show_name: false, show_email: false });
    expect(fieldOf(el, 'name')).toBeNull();
    expect(fieldOf(el, 'email')).toBeNull();
    expect(fieldOf(el, 'message')).toBeTruthy();
  });
});

describe('校验与提交', () => {
  it('空留言不调用接口，并给出提示', async () => {
    const el = await mount({});
    await submitForm(el);
    expect(fake.state.calls).toEqual([]);
    expect(el.querySelector('.pp-contact-error')?.textContent).toBe('请先写下要发送的内容。');
  });

  it('邮箱格式不对不调用接口', async () => {
    const el = await mount({});
    type(fieldOf(el, 'email')!, 'not-an-address');
    type(fieldOf(el, 'message')!, '你好');
    await submitForm(el);
    expect(fake.state.calls).toEqual([]);
    expect(el.querySelector('.pp-contact-error')?.textContent).toBe(
      '回信地址需要包含 @，例如 name@example.com。',
    );
  });

  it('蜜罐被填时不调用接口', async () => {
    const el = await mount({});
    type(fieldOf(el, 'message')!, '你好');
    type(fieldOf(el, 'website')!, 'https://spam.example');
    await submitForm(el);
    expect(fake.state.calls).toEqual([]);
  });

  it('真实后端提交一次，进入成功态', async () => {
    const el = await mount({ success_text: '收到了，谢谢。' });
    type(fieldOf(el, 'name')!, '林可');
    type(fieldOf(el, 'email')!, 'linke@example.com');
    type(fieldOf(el, 'message')!, '  想问问封面是谁拍的？ ');
    await submitForm(el);

    expect(fake.state.calls).toHaveLength(1);
    expect(fake.state.calls[0].siteId).toBe('site_main');
    expect(fake.state.calls[0].body).toEqual({
      name: '林可',
      email: 'linke@example.com',
      message: '想问问封面是谁拍的？',
      website: '',
    });
    expect(el.querySelector('.pp-contact-success')?.textContent).toBe('收到了，谢谢。');
    expect(el.querySelector('.pp-contact-error')).toBeNull();
  });

  it('发送失败显示重试提示，并且不清空用户输入', async () => {
    fake.state.fail = true;
    const el = await mount({});
    type(fieldOf(el, 'message')!, '写了很久的一段话');
    await submitForm(el);

    expect(el.querySelector('.pp-contact-error')?.textContent).toBe('发送失败，请稍后再试。');
    expect(fieldOf(el, 'message')?.value).toBe('写了很久的一段话');
    expect(el.querySelector('.pp-contact-success')).toBeNull();
  });

  it('成功后再提交会被本地冷却挡住，不再调用接口', async () => {
    const el = await mount({});
    type(fieldOf(el, 'message')!, '第一次');
    await submitForm(el);
    expect(fake.state.calls).toHaveLength(1);

    type(fieldOf(el, 'message')!, '第二次');
    await submitForm(el);
    expect(fake.state.calls).toHaveLength(1);
    expect(el.querySelector('.pp-contact-error')?.textContent).toBe('刚发过一条，请稍后再试。');
  });
});

describe('演示模式', () => {
  it('不发请求，直接进入成功态，并标明没有真的发送', async () => {
    fake.state.demo = true;
    const el = await mount({});
    type(fieldOf(el, 'message')!, '演示里的一句');
    await submitForm(el);

    expect(fake.state.calls).toEqual([]);
    expect(el.querySelector('.pp-contact-success')).toBeTruthy();
    expect(el.querySelector('.pp-contact-demo-hint')?.textContent).toBe(
      '演示模式下不会真的发送。',
    );
  });
});

describe('样式', () => {
  it('蜜罐字段是真的移出视口，不是 display:none（后者容易被机器人识破）', () => {
    expect(formCss).toMatch(/\.pp-contact-honeypot\s*\{[^}]*position:\s*absolute/);
    expect(formCss).toMatch(/\.pp-contact-honeypot\s*\{[^}]*left:\s*-9999px/);
  });

  it('错误提示用警示色，成功提示用主题色', () => {
    expect(formCss).toMatch(/\.pp-contact-error\s*\{[^}]*color:\s*var\(--danger\)/);
    expect(formCss).toMatch(/\.pp-contact-success\s*\{[^}]*color:\s*var\(--accent/);
  });
});
