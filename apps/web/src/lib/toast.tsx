import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../components/Icon';

export type ToastTone = 'ok' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

interface ToastApi {
  push(tone: ToastTone, message: string, detail?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      seq.current += 1;
      const id = seq.current;
      setItems((prev) => [...prev.slice(-3), { id, tone, message, detail }]);
      window.setTimeout(() => remove(id), tone === 'error' ? 7000 : 4200);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <span className="toast-mark" aria-hidden>
              <Icon name={item.tone === 'ok' ? 'check' : item.tone === 'error' ? 'alert' : 'info'} size={15} />
            </span>
            <span className="toast-text">
              <strong>{item.message}</strong>
              {item.detail ? <span>{item.detail}</span> : null}
            </span>
            <button type="button" className="toast-close" onClick={() => remove(item.id)} aria-label="关闭提示">
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast 必须在 ToastProvider 内使用');
  return value;
}
