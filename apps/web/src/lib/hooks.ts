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
