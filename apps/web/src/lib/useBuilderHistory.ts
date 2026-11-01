import { useCallback, useRef, useState } from 'react';

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 50;

/**
 * 编排器的小型撤销栈。
 *
 * 每个“提交”是完整的一份布局；50 步足够覆盖一次会话的排版操作。比较用
 * JSON.stringify，配置本来就必须可序列化。
 */
export function useBuilderHistory<T>(initial: T) {
  const [state, setState] = useState<HistoryState<T>>({
    past: [],
    present: initial,
    future: [],
  });
  const current = useRef(initial);
  current.current = state.present;

  const reset = useCallback((value: T) => {
    current.current = value;
    setState({ past: [], present: value, future: [] });
  }, []);

  const commit = useCallback((next: T) => {
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    setState((prev) => ({
      past: [...prev.past, prev.present].slice(-LIMIT),
      present: next,
      future: [],
    }));
    current.current = next;
  }, []);

  const undo = useCallback(() => {
    setState((prev) => {
      if (!prev.past.length) return prev;
      const next = prev.past[prev.past.length - 1];
      return {
        past: prev.past.slice(0, -1),
        present: next,
        future: [prev.present, ...prev.future].slice(0, LIMIT),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((prev) => {
      if (!prev.future.length) return prev;
      const next = prev.future[0];
      return {
        past: [...prev.past, prev.present].slice(-LIMIT),
        present: next,
        future: prev.future.slice(1),
      };
    });
  }, []);

  return {
    value: state.present,
    commit,
    reset,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
