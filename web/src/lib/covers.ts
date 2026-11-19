import type { CSSProperties } from 'react';
import type { ArticleCover, SiteCustomization } from '../types';
import { useCustomization } from './customize';

/**
 * 文章封面的读取与渲染辅助。
 *
 * Beta 1.2 起封面随内容保存（`Content.cover_url` / `cover_alt` / `cover_position` /
 * `cover_hidden` 见契约），站点外观里的 `SiteCustomization.covers` 退成「旧位置」。
 * 所以取值顺序是 **内容字段优先，customization 回退**：老站点没有迁移封面也不会丢，
 * 新内容又能按篇单独设置。
 *
 * 三个读函数（`coverFor` / `visibleCoverFor` / `isCoverHidden`）都新增了可选的
 * `content` 参数：不传时行为与迁移前完全一致，只是多了一个「先看内容」的分支。
 * 没有封面、或封面被隐藏时，卡片继续使用 `Cover` 的程序化装饰封面。
 */

/**
 * 内容对象上与封面有关的字段。
 *
 * 这是 `Content` 的结构子集，所以调用方可以直接把整个内容对象传进来
 * （`visibleCoverFor(customization, item.id, item)`），测试也能只造这几个字段。
 */
export interface CoverCarrier {
  id?: string;
  cover_url?: string;
  cover_alt?: string;
  cover_position?: 'top' | 'center' | 'bottom';
  cover_hidden?: boolean;
}

/**
 * 只接受图片地址。
 *
 * 内容字段由服务端校验过，前端再挡一次 `javascript:` 与非图片 data URL：
 * 封面的值最终会进 `<img src>`，这条线不值得赌服务端版本。
 * 与 `normalizeCoverUrl` 的区别是不设 64 KB 上限——内容封面允许更大的内联图。
 */
function readCoverUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return '';
  if (/^javascript:/i.test(url)) return '';
  if (/^data:/i.test(url) && !/^data:image\//i.test(url)) return '';
  return url;
}

/** 内容对象自带的封面；`cover_url` 为空时返回 undefined（交给旧配置回退）。 */
export function contentCover(content?: CoverCarrier | null): ArticleCover | undefined {
  const url = readCoverUrl(content?.cover_url);
  if (!url) return undefined;
  return {
    id: content?.id ?? '',
    url,
    alt: content?.cover_alt?.trim() || undefined,
    position: content?.cover_position || undefined,
    hidden: content?.cover_hidden === true,
  };
}

/** 旧位置：站点外观配置里按内容 id 保存的封面（Beta 1.2 之前的唯一来源）。 */
function legacyCoverFor(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
): ArticleCover | undefined {
  if (!id) return undefined;
  return customization.covers.find((cover) => cover.id === id);
}

/** 当前内容 id 对应的封面：内容字段优先，旧配置回退。 */
export function coverFor(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
  content?: CoverCarrier | null,
): ArticleCover | undefined {
  return contentCover(content) ?? legacyCoverFor(customization, id);
}

/** 只返回真正可以显示的自定义封面（有地址且没有被隐藏）。 */
export function visibleCoverFor(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
  content?: CoverCarrier | null,
): ArticleCover | undefined {
  // `cover_hidden` 是显式开关，无论封面来自内容还是旧配置都优先。
  if (content?.cover_hidden === true) return undefined;
  const own = contentCover(content);
  if (own) return own;
  const legacy = legacyCoverFor(customization, id);
  if (!legacy || legacy.hidden || !legacy.url) return undefined;
  return legacy;
}

/** 作者明确选择了「不显示封面」：调用方应整块不渲染封面，而不是回退程序化封面。 */
export function isCoverHidden(
  customization: Pick<SiteCustomization, 'covers'>,
  id: string | undefined,
  content?: CoverCarrier | null,
): boolean {
  if (content?.cover_hidden === true) return true;
  // 内容自带封面且没有勾选隐藏：旧配置里的 hidden 不该再压住它。
  if (contentCover(content)) return false;
  return !!legacyCoverFor(customization, id)?.hidden;
}

/** 当前内容 id 对应的自定义封面（可直接用于组件渲染）。 */
export function useArticleCover(
  id: string | undefined,
  content?: CoverCarrier | null,
): ArticleCover | undefined {
  const { customization } = useCustomization();
  return visibleCoverFor(customization, id, content);
}

/** 当前内容是否明确隐藏了封面。 */
export function useCoverHidden(id: string | undefined, content?: CoverCarrier | null): boolean {
  const { customization } = useCustomization();
  return isCoverHidden(customization, id, content);
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
