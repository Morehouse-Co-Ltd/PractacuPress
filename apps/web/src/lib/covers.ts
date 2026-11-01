import type { CSSProperties } from 'react';
import type { ArticleCover, SiteCustomization } from '../types';
import { useCustomization } from './customize';

/**
 * 文章自定义封面的读取与渲染辅助。
 *
 * 封面是展示层配置：契约没有封面字段，配置按内容 id 存在
 * `SiteCustomization.covers`（见 lib/customize.ts 的 normalizeCovers）。
 * 没有配置、或配置被隐藏时，卡片继续使用 `Cover` 的程序化装饰封面。
 */

export function coverFor(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
): ArticleCover | undefined {
  if (!id) return undefined;
  return customization.covers.find((cover) => cover.id === id);
}

/** 只返回真正可以显示的自定义封面（有地址且没有被隐藏）。 */
export function visibleCoverFor(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
): ArticleCover | undefined {
  const cover = coverFor(customization, id);
  if (!cover || cover.hidden || !cover.url) return undefined;
  return cover;
}

/** 作者明确选择了「不显示封面」：调用方应整块不渲染封面，而不是回退程序化封面。 */
export function isCoverHidden(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
): boolean {
  return !!coverFor(customization, id)?.hidden;
}

/** 当前内容 id 对应的自定义封面（可直接用于组件渲染）。 */
export function useArticleCover(id: string | undefined): ArticleCover | undefined {
  const { customization } = useCustomization();
  return visibleCoverFor(customization, id);
}

/** 当前内容是否明确隐藏了封面。 */
export function useCoverHidden(id: string | undefined): boolean {
  const { customization } = useCustomization();
  return isCoverHidden(customization, id);
}

/** 自定义封面的 <img> 内联样式：等比填充 + 焦点位置。 */
export function coverImageStyle(cover: ArticleCover, ratio?: string): CSSProperties {
  const position =
    cover.position === 'top'
      ? '50% 0%'
      : cover.position === 'bottom'
        ? '50% 100%'
        : '50% 50%';
  return {
    objectFit: 'cover',
    objectPosition: position,
    ...(ratio ? { aspectRatio: ratio } : {}),
  };
}

/** 自定义封面的外框样式（改比例时不必再动样式表）。 */
export function coverFrameStyle(ratio?: string): CSSProperties {
  return ratio ? { aspectRatio: ratio } : {};
}

export function coverAlt(cover: ArticleCover, fallback: string): string {
  return cover.alt?.trim() || fallback;
}
