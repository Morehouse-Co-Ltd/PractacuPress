import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HttpBackend, isMediaApiUrl } from './api';
import { useMediaSrc, type MediaSrc } from './assetUrl';
import { BackendProvider, type Backend } from './backend';
import { DemoBackend } from './demo';
import type { Session } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 后台预览的媒体地址。
 *
 * 媒体读取接口是 optionalAuth：content 素材匿名读会 404，而 `<img src>` 带不上
 * Authorization，所以真实后端必须先带令牌取字节再换成 blob:。这里盯住三件事：
 * 请求带了令牌、data:/外链不请求也不换地址、失败时回退原地址而不抛异常。
 */

const SESSION: Session = {
  user: {
    id: 'usr_1',
    display_name: '站长',
    locale: 'zh-CN',
    status: 'active',
    created_at: '2026-11-01T00:00:00Z',
  },
  token_type: 'Bearer',
  access_token: 'access-token',
  access_expires_at: '2026-11-02T01:00:00Z',
  refresh_expires_at: '2026-12-02T00:00:00Z',
  csrf_token: 'csrf-token',
};

function blobResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
  } as unknown as Response;
}

function problemResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ status, code: 'not_found', title: 'not found' }),
  } as unknown as Response;
}

// happy-dom 有 createObjectURL，但这里要断言「谁创建、谁回收」，所以固定一份可控实现。
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let seq = 0;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

function defineUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', value: unknown) {
  Object.defineProperty(URL, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  seq = 0;
  createObjectURL = vi.fn(() => `blob:pp-${++seq}`);
  revokeObjectURL = vi.fn();
  defineUrlMethod('createObjectURL', createObjectURL);
  defineUrlMethod('revokeObjectURL', revokeObjectURL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  defineUrlMethod('createObjectURL', originalCreate);
  defineUrlMethod('revokeObjectURL', originalRevoke);
});

describe('HttpBackend.assetSrc', () => {
  it('对站内媒体带 Authorization 取字节，返回 blob 地址', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return blobResponse();
      }),
    );
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    backend.applySession(SESSION);

    const src = await backend.assetSrc('/api/v1/media/ast_1');

    expect(src).toBe('blob:pp-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/api/v1/media/ast_1');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer access-token');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('api_base 为空时按同源相对地址请求，不重复拼 /api/v1', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return blobResponse();
      }),
    );
    const backend = new HttpBackend({ base: '', onExpired: () => undefined });
    backend.applySession(SESSION);

    await backend.assetSrc('/api/v1/media/ast_2');

    expect(urls).toEqual(['/api/v1/media/ast_2']);
  });

  it('列表返回的绝对地址指向本 API 时同样带令牌', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return blobResponse();
      }),
    );
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    backend.applySession(SESSION);

    await backend.assetSrc('http://api.test/api/v1/media/ast_3');

    expect(calls).toEqual(['http://api.test/api/v1/media/ast_3']);
  });

  it('data URL、blob URL 与 http(s) 外链不发请求，原样返回', async () => {
    const fetchMock = vi.fn(async () => blobResponse());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    backend.applySession(SESSION);

    const dataUrl = 'data:image/png;base64,AAAA';
    const blobUrl = 'blob:http://api.test/existing';
    const external = 'https://cdn.example.com/cover.png';
    // 外链的路径长得像媒体端点也不该带上本站令牌。
    const externalMediaLike = 'https://cdn.example.com/api/v1/media/ast_1';

    expect(await backend.assetSrc(dataUrl)).toBe(dataUrl);
    expect(await backend.assetSrc(blobUrl)).toBe(blobUrl);
    expect(await backend.assetSrc(external)).toBe(external);
    expect(await backend.assetSrc(externalMediaLike)).toBe(externalMediaLike);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求失败时回退原地址，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemResponse(404)));
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    backend.applySession(SESSION);

    await expect(backend.assetSrc('/api/v1/media/missing')).resolves.toBe(
      '/api/v1/media/missing',
    );

    // 断网 / CORS 之类直接抛错：预览失败不该冒泡成页面错误。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(backend.assetSrc('/api/v1/media/offline')).resolves.toBe(
      '/api/v1/media/offline',
    );
  });

  it('演示后端直接返回原地址（素材本来就是 data URL）', async () => {
    const backend = new DemoBackend();
    const url = 'data:image/png;base64,BBBB';
    expect(await backend.assetSrc(url)).toBe(url);
    expect(await backend.assetSrc('/api/v1/media/demo_1')).toBe('/api/v1/media/demo_1');
  });
});

describe('isMediaApiUrl', () => {
  it('只认本站媒体读取端点，data:/外链交给浏览器', () => {
    expect(isMediaApiUrl('/api/v1/media/ast_1')).toBe(true);
    expect(isMediaApiUrl('http://api.test/api/v1/media/ast_1')).toBe(true);
    expect(isMediaApiUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isMediaApiUrl('blob:http://api.test/x')).toBe(false);
    expect(isMediaApiUrl('https://cdn.example.com/cover.png')).toBe(false);
    expect(isMediaApiUrl('/uploads/cover.png')).toBe(false);
    expect(isMediaApiUrl('')).toBe(false);
  });
});

function fakeBackend(assetSrc: (url: string) => Promise<string>): Backend {
  return { assetSrc } as unknown as Backend;
}

function Probe({ url, onRender }: { url: string; onRender: (state: MediaSrc) => void }) {
  const state = useMediaSrc(url);
  onRender(state);
  return createElement('img', { src: state.src || undefined });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mountProbe(assetSrc: (url: string) => Promise<string>, url: string) {
  let latest: MediaSrc | null = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(BackendProvider, {
        backend: fakeBackend(assetSrc),
        children: createElement(Probe, {
          url,
          onRender: (state: MediaSrc) => {
            latest = state;
          },
        }),
      }),
    );
  });
  // 等 assetSrc 的 promise 落地并触发重渲染。
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return () => latest;
}

describe('useMediaSrc', () => {
  it('换成 blob 地址显示，卸载时 revoke 自己造的地址', async () => {
    const assetSrc = vi.fn(async () => 'blob:pp-hook');
    const latest = await mountProbe(assetSrc, '/api/v1/media/ast_9');

    expect(latest()).toEqual({ src: 'blob:pp-hook', failed: false });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = null;

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pp-hook');
  });

  it('取字节失败时回退原地址并标记 failed', async () => {
    const latest = await mountProbe(async (url) => url, '/api/v1/media/gone');

    expect(latest()).toEqual({ src: '/api/v1/media/gone', failed: true });
  });

  it('data URL 原样显示，不标记 failed', async () => {
    const assetSrc = vi.fn(async (url: string) => url);
    const latest = await mountProbe(assetSrc, 'data:image/png;base64,CCCC');

    expect(latest()).toEqual({ src: 'data:image/png;base64,CCCC', failed: false });
    expect(assetSrc).toHaveBeenCalledWith('data:image/png;base64,CCCC');
  });
});
