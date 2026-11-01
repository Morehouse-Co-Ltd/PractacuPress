import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CustomExtension, ExtensionPermission } from '../types';
import {
  buildExtensionDocument,
  extensionStorageKey,
  type ExtensionDocumentContext,
} from '../lib/extensions';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import { cx } from './ui';

/**
 * 单个创作者扩展的宿主。
 *
 * - iframe 只给 `sandbox="allow-scripts"`：没有 allow-same-origin，扩展拿不到
 *   主站 DOM、Cookie 与 localStorage，是独立的不透明源；
 * - 高度由扩展内 `PP.setHeight` 主动上报，宿主限制在 0–2000px；
 * - postMessage 只接受来自这个 iframe 的消息，并逐项校验 pp/id/type；
 * - 未在清单 permissions 里声明过的能力一律忽略（只写 console.debug 方便排查）；
 * - `key` 使用 updated_at：编辑保存后 iframe 会重新挂载，脚本重新执行。
 */

/** 消息 type → 所需权限；setHeight 是布局行为，不需要声明权限。 */
const MESSAGE_PERMISSION: Record<string, ExtensionPermission | null> = {
  setHeight: null,
  notify: 'notify',
  open: 'open_link',
  navigate: 'navigate',
  clipboard: 'clipboard',
  theme: 'theme',
  'storage.set': 'storage',
};

const MAX_FRAME_HEIGHT = 2000;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_STORAGE_VALUE = 2000;
const MAX_STORAGE_ENTRIES = 40;

function stringField(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 读取这个扩展的本地存储快照（沙箱内没有 localStorage，由宿主注入）。 */
function readStorageSnapshot(extensionId: string): Record<string, string> {
  const prefix = extensionStorageKey(extensionId, '');
  const snapshot: Record<string, string> = {};
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const full = window.localStorage.key(index);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (!STORAGE_KEY_PATTERN.test(key)) continue;
      const value = window.localStorage.getItem(full);
      if (value == null) continue;
      snapshot[key] = value.slice(0, MAX_STORAGE_VALUE);
      if (Object.keys(snapshot).length >= MAX_STORAGE_ENTRIES) break;
    }
  } catch {
    /* 无痕模式或存储被禁用时退化为空快照，不影响扩展显示 */
  }
  return snapshot;
}

/** 写入扩展自己的 localStorage 命名空间；key / value 都做长度与格式限制。 */
function writeStorage(extensionId: string, key: string, value: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) return;
  try {
    window.localStorage.setItem(
      extensionStorageKey(extensionId, key),
      value.slice(0, MAX_STORAGE_VALUE),
    );
  } catch {
    /* 配额不足或被禁用时忽略：扩展仍然可以继续运行 */
  }
}

export interface ExtensionHostProps {
  extension: CustomExtension;
  context: ExtensionDocumentContext;
  /** iframe 高度上限；工坊预览传更小的值。 */
  maxHeight?: number;
  /** 预览态：额外样式与更紧凑的高度限制。 */
  preview?: boolean;
  className?: string;
}

export function ExtensionHost({
  extension,
  context,
  maxHeight = MAX_FRAME_HEIGHT,
  preview = false,
  className,
}: ExtensionHostProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(0);

  const limit = Math.min(MAX_FRAME_HEIGHT, Math.max(0, Math.round(maxHeight)));
  const contextSignature = `${context.page}|${context.title ?? ''}|${context.theme.background}|${context.theme.ink}|${context.theme.accent}|${context.theme.font}`;
  const storageSnapshot = useMemo(
    () => readStorageSnapshot(extension.id),
    // 编辑保存（updated_at）或换扩展时重新读一次；预览输入时不必反复扫描 localStorage。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extension.id, extension.updated_at],
  );
  const srcDoc = useMemo(
    () =>
      buildExtensionDocument(extension, {
        ...context,
        extensionId: extension.id,
        // 没声明 storage 权限时不注入快照：桥里的读取也只能拿到空缓存。
        storage: extension.permissions.includes('storage') ? storageSnapshot : {},
      }),
    // contextSignature 覆盖 context 的全部内容，避免内联对象每次渲染都重拼文档。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extension, contextSignature, storageSnapshot],
  );

  // 重新挂载或保存出新版本时先归零，等新文档上报高度，避免残留旧高度。
  useEffect(() => {
    setFrameHeight(0);
  }, [extension.id, extension.updated_at]);

  /**
   * 主动问一次高度。
   *
   * 桥自己在 load 与几个时间点会上报，但扩展脚本或样式较慢时可能错过；
   * iframe 的 load 事件触发一次 ping，能覆盖“消息早于宿主监听器”的边界情况。
   */
  const requestHeight = () => {
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    try {
      target.postMessage({ pp: true, id: extension.id, type: 'ping', payload: {} }, '*');
    } catch {
      /* iframe 已卸载时忽略 */
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(requestHeight, 600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extension.id, extension.updated_at]);

  // 用 ref 持有最新状态：监听器只需按 iframe 生命周期挂一次，输入时不反复解绑。
  const latest = useRef({ extension, context, limit });
  latest.current = { extension, context, limit };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // 只接受这个 iframe 发来的消息：别的窗口 / 扩展无法伪造来源。
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as unknown;
      if (!data || typeof data !== 'object') return;
      const message = data as { pp?: unknown; id?: unknown; type?: unknown; payload?: unknown };
      if (message.pp !== true) return;
      const state = latest.current;
      if (message.id !== state.extension.id) return;
      if (typeof message.type !== 'string') return;
      const type = message.type as keyof typeof MESSAGE_PERMISSION;
      if (!(type in MESSAGE_PERMISSION)) return;

      const required = MESSAGE_PERMISSION[type];
      if (required && !state.extension.permissions.includes(required)) {
        // 未授权：直接忽略，不执行、不报错，只在调试面板留一行。
        console.debug(`[扩展 ${state.extension.name}] 未声明 ${required} 权限，已忽略 ${type} 请求。`);
        return;
      }

      const payload =
        message.payload && typeof message.payload === 'object'
          ? (message.payload as Record<string, unknown>)
          : {};

      switch (type) {
        case 'setHeight': {
          const raw = Number(payload.height);
          if (!Number.isFinite(raw)) return;
          const next = Math.min(state.limit, Math.max(0, Math.round(raw)));
          setFrameHeight((previous) => (previous === next ? previous : next));
          return;
        }
        case 'notify': {
          const text = stringField(payload.message, 200).trim();
          if (!text) return;
          toast.push('info', text, state.extension.name);
          return;
        }
        case 'open': {
          const href = stringField(payload.href, 1000).trim();
          if (!/^https?:\/\//i.test(href)) {
            console.debug(`[扩展 ${state.extension.name}] 只允许打开 http(s) 链接。`);
            return;
          }
          window.open(href, '_blank', 'noopener');
          return;
        }
        case 'navigate': {
          const path = stringField(payload.path, 500).trim();
          // 只允许站内绝对路径；`//evil.com` 会被浏览器当作协议相对外链，必须排掉。
          if (!path.startsWith('/') || path.startsWith('//')) {
            console.debug(`[扩展 ${state.extension.name}] 只能跳转到站内路径。`);
            return;
          }
          navigate(path);
          return;
        }
        case 'clipboard': {
          const text = stringField(payload.text, MAX_STORAGE_VALUE);
          if (!text) return;
          void copyText(text);
          return;
        }
        case 'theme': {
          const target = frame.contentWindow;
          if (!target) return;
          const theme = state.context.theme;
          target.postMessage(
            { pp: true, id: state.extension.id, type: 'theme', payload: theme },
            '*',
          );
          return;
        }
        case 'storage.set': {
          const key = stringField(payload.key, 64);
          if (!STORAGE_KEY_PATTERN.test(key)) return;
          const value = stringField(payload.value, MAX_STORAGE_VALUE);
          writeStorage(state.extension.id, key, value);
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate, toast]);

  // 扩展内容变化（保存后 updated_at 改变）时重挂 iframe，脚本从头执行。
  const frameKey = `${extension.id}:${extension.updated_at}`;

  return (
    <div
      className={cx('ppe-host', preview && 'is-preview', className)}
      data-pp-extension={extension.id}
    >
      <iframe
        ref={frameRef}
        key={frameKey}
        className="ppe-frame"
        sandbox="allow-scripts"
        data-pp-extension={extension.id}
        title={extension.name}
        srcDoc={srcDoc}
        onLoad={requestHeight}
        style={{ height: `${frameHeight}px` }}
      />
    </div>
  );
}
