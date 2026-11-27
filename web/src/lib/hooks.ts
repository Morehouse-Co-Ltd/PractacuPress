import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type RefObject,
} from 'react';
import { errorText as translateError } from './i18n';

/**
 * 把异常变成可展示的提示。
 *
 * 真实后端错误带 `problem.code`，英文界面下由 `lib/i18n` 按代码翻译；
 * 中文界面下仍然原样显示服务端 message。
 */
export function errorText(err: unknown): string {
  return translateError(err);
}

export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const current = ++seq.current;
    let alive = true;
    setLoading(true);
    loader()
      .then((value) => {
        if (!alive || current !== seq.current) return;
        setData(value);
        setError(null);
      })
      .catch((err) => {
        if (!alive || current !== seq.current) return;
        setError(err);
      })
      .finally(() => {
        if (!alive || current !== seq.current) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { data, error, loading, reload, setData };
}

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) handler();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, handler, active]);
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Practacu Press` : 'Practacu Press';
  }, [title]);
}

/**
 * 订阅一个媒体查询。用于需要换一套 DOM 而不只是换样式的窄屏布局：
 * 隐藏桌面表格、渲染按组卡片，避免两套可交互控件同时留在无障碍树里。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function useScrollProgress() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const height = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(height > 0 ? Math.min(1, window.scrollY / height) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
  return progress;
}

export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

/* ------------------------- 编辑器本地草稿 ------------------------- */

/**
 * 自动保存的本地草稿。
 *
 * 编辑器每改一次就写 localStorage 会太频繁，完全不写又会在断网、崩溃、误关标签时丢稿，
 * 所以这里做「停止输入 delayMs 后写一次」的防抖，并额外设一个 maxWaitMs 上限：连续打字
 * 超过上限时也落一次盘。页面隐藏 / 关闭时同步补一次，避免最后一两秒的修改丢失。
 *
 * 草稿按「站点 + 内容类型 + 内容 ID」隔离，新建内容用固定的 `new` 位。服务端保存成功后
 * 调用 `clear()` 清掉草稿；是否把草稿灌回编辑器由页面决定，这个 hook 只负责存取。
 */

const EDITOR_DRAFT_PREFIX = 'pp.editor.draft.v1';
const EDITOR_DRAFT_VERSION = 1;
const EDITOR_DRAFT_BODY_LIMIT = 200_000;

export interface EditorDraftPayload {
  title: string;
  slug: string;
  summary: string;
  source_format: 'markdown';
  source_body: string;
  category_id: string;
  tags: string[];
}

export interface EditorDraftRecord {
  version: number;
  key: string;
  kind: string;
  content_id: string | null;
  site_id: string;
  /** 本地写入时间（epoch ms）。 */
  saved_at: number;
  /** 写草稿时看到的服务端版本号；恢复时用它判断服务端有没有更新过。 */
  base_revision: number | null;
  /** 写草稿时看到的服务端 updated_at；旧数据没有 revision 时用它兜底。 */
  server_updated_at: string | null;
  payload: EditorDraftPayload;
}

export interface EditorDraftScope {
  siteId?: string | null;
  kind: string;
  /** 已有内容的 ID；新建内容传 null，使用固定的临时草稿位。 */
  contentId?: string | null;
}

function draftSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
}

export function editorDraftKey(scope: EditorDraftScope): string {
  const site = draftSegment(scope.siteId || 'local');
  const kind = draftSegment(scope.kind || 'content');
  const content = scope.contentId ? `c:${draftSegment(scope.contentId)}` : 'new';
  return `${EDITOR_DRAFT_PREFIX}:${site}:${kind}:${content}`;
}

/** 解析存盘记录；版本不符或结构损坏一律当作没有草稿。 */
export function parseEditorDraft(raw: string | null | undefined): EditorDraftRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<EditorDraftRecord>;
  if (record.version !== EDITOR_DRAFT_VERSION || typeof record.key !== 'string') return null;
  if (typeof record.saved_at !== 'number' || !Number.isFinite(record.saved_at)) return null;

  const payload = record.payload as Partial<EditorDraftPayload> | null | undefined;
  if (!payload || typeof payload !== 'object') return null;
  if (
    typeof payload.title !== 'string' ||
    typeof payload.slug !== 'string' ||
    typeof payload.summary !== 'string' ||
    typeof payload.source_body !== 'string' ||
    typeof payload.category_id !== 'string' ||
    !Array.isArray(payload.tags) ||
    !payload.tags.every((tag) => typeof tag === 'string')
  ) {
    return null;
  }

  return {
    version: EDITOR_DRAFT_VERSION,
    key: record.key,
    kind: typeof record.kind === 'string' ? record.kind : '',
    content_id: typeof record.content_id === 'string' ? record.content_id : null,
    site_id: typeof record.site_id === 'string' ? record.site_id : '',
    saved_at: record.saved_at,
    base_revision: typeof record.base_revision === 'number' ? record.base_revision : null,
    server_updated_at: typeof record.server_updated_at === 'string' ? record.server_updated_at : null,
    payload: {
      title: payload.title,
      slug: payload.slug,
      summary: payload.summary,
      source_format: 'markdown',
      source_body: payload.source_body.slice(0, EDITOR_DRAFT_BODY_LIMIT),
      category_id: payload.category_id,
      tags: payload.tags.slice(0, 12),
    },
  };
}

function draftStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // 某些隐私模式 / 站点策略会直接抛 SecurityError，当成没有本地存储。
    return null;
  }
}

export function readEditorDraft(key: string): EditorDraftRecord | null {
  const storage = draftStorage();
  if (!storage) return null;
  try {
    return parseEditorDraft(storage.getItem(key));
  } catch {
    return null;
  }
}

export function writeEditorDraft(record: EditorDraftRecord): boolean {
  const storage = draftStorage();
  if (!storage) return false;
  try {
    storage.setItem(record.key, JSON.stringify(record));
    return true;
  } catch {
    // 配额满或存储被禁用：让页面提示用户手动保存，别让编辑器本身崩掉。
    return false;
  }
}

export function removeEditorDraft(key: string): void {
  const storage = draftStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* 清不掉不影响继续编辑 */
  }
}

/**
 * 草稿是否落后于服务端。
 *
 * 有版本号时只认版本号：同一次保存之后本地时钟和服务端时钟的误差不该制造假冲突。
 * 旧数据没有 revision 时再比较 `updated_at`。任一字段不同都认为服务端已经更新过，
 * 恢复前必须让作者明确选择，绝不悄悄用本地草稿覆盖服务器内容。
 */
export function draftIsStale(
  draft: EditorDraftRecord,
  server: { revision?: number | null; updatedAt?: string | null } | null | undefined,
): boolean {
  if (!server) return false;
  if (
    typeof server.revision === 'number' &&
    draft.base_revision !== null &&
    server.revision !== draft.base_revision
  ) {
    return true;
  }
  if (server.updatedAt && draft.server_updated_at && server.updatedAt !== draft.server_updated_at) {
    return true;
  }
  return false;
}

export type EditorAutosaveState = 'idle' | 'saving' | 'saved' | 'error';

export function useEditorAutosave({
  storageKey,
  kind,
  contentId,
  siteId,
  payload,
  enabled,
  baseRevision = null,
  serverUpdatedAt = null,
  restoredSavedAt = null,
  delayMs = 1200,
  maxWaitMs = 8000,
  onError,
}: {
  storageKey: string;
  kind: string;
  contentId?: string | null;
  siteId?: string | null;
  payload: EditorDraftPayload | null;
  /** 只在「可编辑 + 有改动 + 尚未决定旧草稿」时为 true。 */
  enabled: boolean;
  baseRevision?: number | null;
  serverUpdatedAt?: string | null;
  /** 刚恢复的草稿时间：让状态栏立刻显示上一次自动保存的时间。 */
  restoredSavedAt?: number | null;
  delayMs?: number;
  maxWaitMs?: number;
  onError?: () => void;
}) {
  const [state, setState] = useState<EditorAutosaveState>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(restoredSavedAt);

  const serialized = payload ? JSON.stringify(payload) : '';
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const metaRef = useRef({ storageKey, kind, contentId, siteId, baseRevision, serverUpdatedAt });
  metaRef.current = { storageKey, kind, contentId, siteId, baseRevision, serverUpdatedAt };
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** 上一次成功落盘的内容；相同内容不重复写，避免每次重渲染都碰 localStorage。 */
  const lastWrittenRef = useRef('');
  /** 这一轮修改第一次发生的时间，用来兜住连续打字导致防抖永不触发。 */
  const dirtySinceRef = useRef(0);
  const errorNotifiedRef = useRef(false);

  useEffect(() => {
    if (restoredSavedAt) {
      setSavedAt(restoredSavedAt);
      setState('saved');
    }
  }, [restoredSavedAt]);

  const flush = useCallback((): boolean => {
    if (!enabledRef.current) return false;
    const value = serializedRef.current;
    if (!value || value === lastWrittenRef.current) return false;
    const meta = metaRef.current;
    let data: EditorDraftPayload;
    try {
      data = JSON.parse(value) as EditorDraftPayload;
    } catch {
      return false;
    }
    const record: EditorDraftRecord = {
      version: EDITOR_DRAFT_VERSION,
      key: meta.storageKey,
      kind: meta.kind,
      content_id: meta.contentId ?? null,
      site_id: meta.siteId ?? '',
      saved_at: Date.now(),
      base_revision: meta.baseRevision ?? null,
      server_updated_at: meta.serverUpdatedAt ?? null,
      payload: data,
    };
    if (writeEditorDraft(record)) {
      lastWrittenRef.current = value;
      dirtySinceRef.current = 0;
      errorNotifiedRef.current = false;
      setSavedAt(record.saved_at);
      setState('saved');
      return true;
    }
    setState('error');
    if (!errorNotifiedRef.current) {
      errorNotifiedRef.current = true;
      onErrorRef.current?.();
    }
    return false;
  }, []);

  // 改回和服务端一致（或进入只读）时收起「正在保存」，别让状态栏一直转。
  useEffect(() => {
    if (enabled) return;
    dirtySinceRef.current = 0;
    setState((prev) => (prev === 'saving' ? 'idle' : prev));
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !serialized) return;
    if (serialized === lastWrittenRef.current) {
      // 改回与服务端一致（撤销 / 手动改回原文）时不会再触发 flush，这里要把上一笔
      // 编辑留下的「正在保存」收掉，否则状态栏会永远停在保存中。
      setState((prev) => (prev === 'saving' ? 'saved' : prev));
      return;
    }
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    const elapsed = Date.now() - dirtySinceRef.current;
    setState((prev) => (prev === 'saving' ? prev : 'saving'));
    if (elapsed >= maxWaitMs) {
      flush();
      return;
    }
    const timer = window.setTimeout(() => {
      flush();
    }, Math.min(delayMs, maxWaitMs - elapsed));
    return () => window.clearTimeout(timer);
  }, [serialized, enabled, delayMs, maxWaitMs, flush]);

  // 关闭标签 / 切到后台时同步补一次：防抖还在等待的最后几秒修改也不会丢。
  useEffect(() => {
    const persistIfNeeded = () => {
      if (!enabledRef.current) return;
      if (serializedRef.current && serializedRef.current !== lastWrittenRef.current) flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persistIfNeeded();
    };
    window.addEventListener('pagehide', persistIfNeeded);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', persistIfNeeded);
      document.removeEventListener('visibilitychange', onVisibility);
      // SPA 内跳转不会触发 pagehide，卸载时补一次。
      persistIfNeeded();
    };
  }, [flush]);

  const clear = useCallback(() => {
    // 把当前内容记成「已处理」，卸载时的补写不会再把它写回存储。
    lastWrittenRef.current = serializedRef.current;
    dirtySinceRef.current = 0;
    errorNotifiedRef.current = false;
    removeEditorDraft(metaRef.current.storageKey);
    setSavedAt(null);
    setState('idle');
  }, []);

  return { state, savedAt, flush, clear };
}

/**
 * 元素首次进入视口时返回 true，随后断开观察。
 * 区块入场动画用它触发：只观察一次，不随滚动重渲染。
 */
export function useInView<T extends HTMLElement>(ref: RefObject<T | null>, rootMargin = '0px 0px -8% 0px') {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, seen, rootMargin]);
  return seen;
}
