import type { BlockAnimation } from '../types';

/**
 * 入场动画的统一关键帧。
 *
 * CSS 与 Web Animations 共用同一组定义：CSS 负责首屏的过渡外观，WAAPI 负责在
 * 编排器“预览动画”和切换动画时可靠重播，不受 React 类名是否变化影响。
 */
export function animationFrames(animation: BlockAnimation | string): Keyframe[] {
  switch (animation) {
    case 'fade':
      return [{ opacity: 0 }, { opacity: 1 }];
    case 'slide-left':
      return [
        { opacity: 0, transform: 'translateX(-28px)' },
        { opacity: 1, transform: 'none' },
      ];
    case 'slide-right':
      return [
        { opacity: 0, transform: 'translateX(28px)' },
        { opacity: 1, transform: 'none' },
      ];
    case 'zoom':
      return [
        { opacity: 0, transform: 'scale(.94)' },
        { opacity: 1, transform: 'none' },
      ];
    case 'none':
      return [];
    default:
      return [
        { opacity: 0, transform: 'translateY(18px)' },
        { opacity: 1, transform: 'none' },
      ];
  }
}

export function playBlockAnimation(target: HTMLElement, animation: BlockAnimation | string): void {
  const frames = animationFrames(animation);
  if (!frames.length) return;
  target.animate(frames, {
    duration: 520,
    easing: 'cubic-bezier(.22,.68,.28,1)',
    fill: 'both',
  });
}
