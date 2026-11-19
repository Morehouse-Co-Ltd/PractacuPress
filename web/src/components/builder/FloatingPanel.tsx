import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../Icon';
import { useT } from '../../lib/i18n';
import { clampPanelPosition, snapPanelPosition, type PanelPosition } from '../../lib/panelPosition';

/**
 * 页面编排器两侧的浮动面板。
 *
 * - 标题栏就是拖拽手柄：按住可把面板移到任意位置，位置记在 localStorage；
 * - 双击标题栏复位到默认停靠位；
 * - 拖动时夹在窗口内，标题栏始终可抓；
 * - 松手时如果离左右边缘够近，会自动吸附到边上；
 * - 指针事件用 requestAnimationFrame 合并，拖动更跟手；超过 4px 才算拖动，
 *   避免想点标题栏按钮时面板先抖一下；
 * - 滚动条隐藏（内容仍可滚轮/触控滚动），避免两侧出现突兀的进度条。
 */

const STORAGE_KEY = 'pp.builder.panels.v1';
/** 小于这个位移视为点击，不进入拖动状态。 */
const DRAG_THRESHOLD = 4;

export type PanelSide = 'left' | 'right';

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  origin: PanelPosition;
  moved: boolean;
}

function readSavedPosition(side: PanelSide): PanelPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<PanelSide, PanelPosition>>;
    const value = parsed?.[side];
    if (!value || typeof value !== 'object') return null;
    const { left, top, height } = value;
    if (![left, top, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
      return null;
    }
    return { left, top, height };
  } catch {
    return null;
  }
}

function writeSavedPosition(side: PanelSide, position: PanelPosition | null): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, PanelPosition>) : {};
    if (position) parsed[side] = position;
    else delete parsed[side];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // 本地存储不可用时只是记不住位置，不影响拖动本身。
  }
}

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function FloatingPanel({
  side,
  title,
  onClose,
  aside,
  children,
}: {
  side: PanelSide;
  title: string;
  onClose: () => void;
  /** 标题栏右侧、关闭按钮之前的附加操作（例如「逻辑链」）。 */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<PanelPosition | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const [position, setPosition] = useState<PanelPosition | null>(() => readSavedPosition(side));
  const [dragging, setDragging] = useState(false);

  // 记住过的位置可能在更小的窗口里跑出屏幕：挂载与缩放时重新夹一次。
  useEffect(() => {
    const clampToViewport = () => {
      setPosition((current) => {
        if (!current) return current;
        return clampPanelPosition(current, viewportSize(), panelRef.current?.offsetWidth ?? 320);
      });
    };
    clampToViewport();
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  useEffect(() => {
    if (dragging) return;
    writeSavedPosition(side, position);
  }, [dragging, position, side]);

  // 拖动期间给 body 加类：全局显示抓手光标并禁止选中文字。
  useEffect(() => {
    document.body.classList.toggle('builder-panel-dragging', dragging);
    return () => {
      document.body.classList.remove('builder-panel-dragging');
    };
  }, [dragging]);

  useEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      document.body.classList.remove('builder-panel-dragging');
    },
    [],
  );

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 标题栏里的按钮/链接保持原有行为，不触发拖动。
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea, [contenteditable="true"]')) {
      return;
    }
    const panel = panelRef.current;
    if (!panel || dragRef.current) return;

    const rect = panel.getBoundingClientRect();
    const drag: DragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top, height: rect.height },
      moved: false,
    };
    dragRef.current = drag;
    try {
      panel.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件或浏览器不支持捕获时忽略：window 上的监听仍然能继续拖动。
    }

    const applyFrame = () => {
      frameRef.current = null;
      if (pendingRef.current) {
        setPosition(pendingRef.current);
        pendingRef.current = null;
      }
    };

    const schedule = (next: PanelPosition) => {
      pendingRef.current = next;
      if (frameRef.current == null) {
        frameRef.current = requestAnimationFrame(applyFrame);
      }
    };

    const stopListening = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };

    const handleMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== drag.pointerId) return;
      const dx = pointerEvent.clientX - drag.startX;
      const dy = pointerEvent.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        setDragging(true);
      }
      pointerEvent.preventDefault();
      schedule(
        clampPanelPosition(
          { left: drag.origin.left + dx, top: drag.origin.top + dy, height: drag.origin.height },
          viewportSize(),
          panel.offsetWidth,
        ),
      );
    };

    const finish = (pointerEvent?: PointerEvent) => {
      if (pointerEvent && pointerEvent.pointerId !== drag.pointerId) return;
      stopListening();
      detachRef.current = null;
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      dragRef.current = null;

      if (drag.moved) {
        // 松手吸附：只处理最后一次位置，避免拖动中间状态触发两次渲染。
        setPosition((current) => {
          const base = pending ?? current;
          if (!base) return base;
          return snapPanelPosition(base, viewportSize(), panel.offsetWidth);
        });
      }
      setDragging(false);
    };

    detachRef.current = stopListening;
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const resetPosition = () => {
    dragRef.current = null;
    setDragging(false);
    setPosition(null);
  };

  const style: CSSProperties | undefined = position
    ? {
        left: position.left,
        top: position.top,
        right: 'auto',
        bottom: 'auto',
        height: position.height,
      }
    : undefined;

  return (
    <div
      ref={panelRef}
      className={`builder-float builder-float-${side}${dragging ? ' is-dragging' : ''}${
        position ? ' is-detached' : ''
      }`}
      style={style}
    >
      <div
        className="builder-float-head"
        title={t('按住拖动面板；拖到左右边缘会自动吸附，双击复位')}
        onPointerDown={beginDrag}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a')) return;
          resetPosition();
        }}
      >
        <span className="builder-float-grip" aria-hidden>
          ⠿
        </span>
        <span className="builder-float-title">{title}</span>
        <span className="builder-float-actions">
          {aside}
          <button
            type="button"
            className="builder-float-close"
            onClick={onClose}
            aria-label={t('收起{title}面板', { title })}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      {children}
    </div>
  );
}
