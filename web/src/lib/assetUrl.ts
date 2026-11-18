import { useEffect, useMemo, useState } from 'react';
import { isMediaApiUrl } from './api';
import { useBackend } from './backend';

export interface MediaSrc {
  /** 可以直接放进 `<img src>` 的地址；还在取字节时为空串。 */
  src: string;
  /** 真实后端取字节失败：调用方应显示占位图标，而不是留一个空白框。 */
  failed: boolean;
}

interface MediaSrcState extends MediaSrc {
  /** 这份结果对应的输入地址；输入一变就按新地址重新取。 */
  forUrl: string;
}

function initialSrc(url: string): MediaSrc {
  // 站内媒体要等带鉴权的 blob：先留空，避免 <img> 先发一次必然 404 的匿名请求；
  // data:/blob:/外链浏览器自己就能显示，立刻给原地址。
  return { src: isMediaApiUrl(url) ? '' : url, failed: false };
}

/**
 * 把媒体地址换成浏览器真的能显示的地址。
 *
 * 后台预览里的 `<img src>` 带不上 Authorization，站内 content 素材会被匿名读取
 * 挡成 404（见 internal/media/service.go 的 authorizeSharedAsset），
 * 所以统一走 backend.assetSrc：真实后端换成带鉴权的 blob:，演示模式与外链原样
 * 返回。blob: 是这里新造的，换地址或卸载时必须 revoke，否则会一直占着内存。
 */
export function useMediaSrc(url: string | undefined): MediaSrc {
  const backend = useBackend();
  const raw = (url ?? '').trim();
  const initial = useMemo(() => initialSrc(raw), [raw]);
  const [state, setState] = useState<MediaSrcState>(() => ({ forUrl: raw, ...initial }));

  useEffect(() => {
    if (!raw) {
      setState({ forUrl: raw, src: '', failed: false });
      return;
    }
    // 旧适配层或测试桩可能没有 assetSrc：按原地址显示，保持改造前的行为。
    if (typeof backend.assetSrc !== 'function') {
      setState({ forUrl: raw, src: raw, failed: false });
      return;
    }

    // 组件卸载、地址变化后迟到的结果不能再改状态，自己造出来的 blob 也要回收。
    let alive = true;
    let created: string | null = null;
    const needsAuth = isMediaApiUrl(raw);
    // 地址变了但 effect 还没跑时先摆好初始状态；首次挂载时状态已经是它，不用重渲染。
    setState((prev) => (prev.forUrl === raw ? prev : { forUrl: raw, ...initialSrc(raw) }));

    backend.assetSrc(raw).then(
      (next) => {
        const blob = next !== raw && next.startsWith('blob:') ? next : null;
        created = blob;
        if (!alive) {
          if (blob) URL.revokeObjectURL(blob);
          return;
        }
        setState({ forUrl: raw, src: next || raw, failed: next === raw && needsAuth });
      },
      () => {
        // 取字节失败时回退原地址：图片元素自己再试一次，调用方按 failed 决定占位。
        if (alive) setState({ forUrl: raw, src: raw, failed: needsAuth });
      },
    );

    return () => {
      alive = false;
      if (created) {
        URL.revokeObjectURL(created);
        created = null;
      }
    };
  }, [backend, raw]);

  // raw 刚变、effect 还没跑时先按新地址的初始状态渲染，避免闪一下上一张图。
  return state.forUrl === raw ? { src: state.src, failed: state.failed } : initial;
}
