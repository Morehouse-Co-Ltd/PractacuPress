import { useEffect } from 'react';
import { playBlockAnimation } from '../lib/blockAnimations';
import { useT } from '../lib/i18n';

const MIME_BLOCK = 'application/x-pp-block';
const MIME_NEW = 'application/x-pp-new';

/**
 * 页面编排器 iframe 的预览桥。
 *
 * - 点击真实前台里的区块，回传区块 id；
 * - 接收选中高亮、动画重播；
 * - 接管从父窗口拖进来的组件：在真实区块上方/下方画插入线，松开后回传目标位置。
 *
 * 普通前台访问不会注册任何行为；消息只接受同源来源。
 */
export function PreviewBridge() {
  const t = useT();

  useEffect(() => {
    if (window.parent === window) return;

    let lastTarget: HTMLElement | null = null;
    let lastPosition: 'before' | 'after' = 'after';
    let resizeHandle: HTMLElement | null = null;

    const clearDrop = () => {
      lastTarget?.classList.remove('pp-drop-before', 'pp-drop-after');
      lastTarget = null;
    };

    const clearResize = () => {
      resizeHandle?.remove();
      resizeHandle = null;
    };

    const attachResize = (target: HTMLElement) => {
      clearResize();
      const handle = document.createElement('div');
      handle.className = 'pp-resize-handle';
      handle.title = t('拖拽调整组件大小');
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = target.getBoundingClientRect().width;
        const startHeight = target.getBoundingClientRect().height;
        const move = (moveEvent: PointerEvent) => {
          const width = Math.max(80, Math.round(startWidth + moveEvent.clientX - startX));
          const height = Math.max(40, Math.round(startHeight + moveEvent.clientY - startY));
          window.parent.postMessage(
            { type: 'pp:preview-resize', blockId: target.dataset.ppBlock, width, height },
            window.location.origin,
          );
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      target.appendChild(handle);
      resizeHandle = handle;
    };

    const blockAt = (target: EventTarget | null): HTMLElement | null =>
      (target as HTMLElement | null)?.closest<HTMLElement>('[data-pp-block]') ?? null;

    const onClick = (event: MouseEvent) => {
      const target = blockAt(event.target);
      if (!target?.dataset.ppBlock) return;
      // 编排器里点击区块是“选中”，不是跳转。
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage(
        { type: 'pp:preview-select', blockId: target.dataset.ppBlock },
        window.location.origin,
      );
    };

    const onDblClick = (event: MouseEvent) => {
      const target = blockAt(event.target);
      if (!target?.dataset.ppBlock) return;
      // 双击 = 请编排器把视角移动到这块组件上。
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage(
        { type: 'pp:preview-locate-request', blockId: target.dataset.ppBlock },
        window.location.origin,
      );
    };

    const onDragOver = (event: DragEvent) => {
      if (
        !event.dataTransfer?.types.includes(MIME_BLOCK) &&
        !event.dataTransfer?.types.includes(MIME_NEW)
      ) {
        return;
      }
      const target = blockAt(event.target);
      if (!target?.dataset.ppBlock) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MIME_NEW) ? 'copy' : 'move';
      const rect = target.getBoundingClientRect();
      const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      if (lastTarget !== target) {
        clearDrop();
        lastTarget = target;
      }
      lastPosition = position;
      target.classList.toggle('pp-drop-before', position === 'before');
      target.classList.toggle('pp-drop-after', position === 'after');
    };

    const onDrop = (event: DragEvent) => {
      const target = blockAt(event.target);
      if (!target?.dataset.ppBlock) return;
      event.preventDefault();
      event.stopPropagation();
      const sourceId =
        event.dataTransfer?.getData(MIME_BLOCK) || event.dataTransfer?.getData('text/plain') || '';
      const newType = event.dataTransfer?.getData(MIME_NEW) || '';
      const position = lastPosition;
      clearDrop();
      window.parent.postMessage(
        {
          type: 'pp:preview-drop',
          targetId: target.dataset.ppBlock,
          position,
          sourceId: newType ? '' : sourceId,
          newType,
        },
        window.location.origin,
      );
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.target === document.documentElement || event.target === document.body) clearDrop();
    };

    /**
     * 高亮是直接改 DOM class 的，但区块进入视口时 React 会重新计算 className，
     * 把手动加的类冲掉（滚动定位恰好会触发）。这里在动画期间持续补回，
     * 保证高亮完整显示到结束，再移除。
     */
    const highlightTimers = new Map<string, Map<HTMLElement, number>>();
    const pulseHighlight = (target: HTMLElement, className: string, duration: number) => {
      let targets = highlightTimers.get(className);
      if (!targets) {
        targets = new Map();
        highlightTimers.set(className, targets);
      }
      const previous = targets.get(target);
      if (previous) cancelAnimationFrame(previous);
      target.classList.add(className);
      const end = performance.now() + duration;
      const tick = () => {
        if (performance.now() >= end) {
          target.classList.remove(className);
          targets?.delete(target);
          return;
        }
        if (!target.classList.contains(className)) target.classList.add(className);
        const frame = requestAnimationFrame(tick);
        targets?.set(target, frame);
      };
      targets.set(target, requestAnimationFrame(tick));
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; blockId?: string; animation?: string } | null;

      if (data?.type === 'pp:preview-focus') {
        if (!data.blockId) {
          clearResize();
          return;
        }
        const target = document.querySelector<HTMLElement>(`[data-pp-block="${data.blockId}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pulseHighlight(target, 'pp-preview-focus', 1400);
        attachResize(target);
        return;
      }

      if (data?.type === 'pp:preview-locate' && data.blockId) {
        const target = document.querySelector<HTMLElement>(`[data-pp-block="${data.blockId}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('pp-preview-locate');
        void target.offsetWidth;
        pulseHighlight(target, 'pp-preview-locate', 1800);
        attachResize(target);
        return;
      }

      if (data?.type === 'pp:preview-animation' && data.blockId) {
        const target = document.querySelector<HTMLElement>(`[data-pp-block="${data.blockId}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('is-in');
        target.classList.add('pp-anim-ready');
        const animation = data.animation && data.animation !== 'none' ? data.animation : 'fade-up';
        target.classList.remove('pp-anim', 'pp-anim-fade', 'pp-anim-fade-up', 'pp-anim-slide-left', 'pp-anim-slide-right', 'pp-anim-zoom');
        target.classList.add('pp-anim', `pp-anim-${animation}`);
        void target.offsetWidth;
        target.classList.add('is-in');
        playBlockAnimation(target, animation);
      }
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('message', onMessage);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('dblclick', onDblClick, true);
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('message', onMessage);
      clearDrop();
      clearResize();
    };
  }, []);

  return null;
}
