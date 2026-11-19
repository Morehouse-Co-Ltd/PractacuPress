import { describe, expect, it } from 'vitest';

/**
 * 回归闸门：扩展编辑链路不许依赖整页刷新。
 *
 * 用户的要求是「改扩展时页面不弹刷新、不整页刷新」，所以这条链路（管理页、编辑器、
 * 沙箱宿主、清单与草稿逻辑）里一旦出现 `location.reload()`、`location.href = ...`
 * 或「请刷新」提示，这里就会失败。就地更新由组件状态完成，不需要也不应该重载页面。
 */

const sources = import.meta.glob(
  '../{pages/admin/Extensions.tsx,components/ExtensionStudio.tsx,components/ExtensionHost.tsx,lib/extensions.ts,lib/extensionDraft.ts}',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** 会让浏览器整页重载 / 跳转的写法。 */
const HARD_NAVIGATION =
  /location\s*\.\s*(reload|assign|replace)\s*\(|location\s*\.\s*href\s*=|document\s*\.\s*location\s*=/;

const REFRESH_PROMPT = /请刷新|刷新页面后重试|刷新一下页面|需要刷新页面/;

describe('扩展编辑链路不依赖整页刷新', () => {
  it('扫描到全部相关文件', () => {
    const paths = Object.keys(sources);
    expect(paths).toHaveLength(5);
    expect(paths.some((path) => path.endsWith('pages/admin/Extensions.tsx'))).toBe(true);
    expect(paths.some((path) => path.endsWith('components/ExtensionStudio.tsx'))).toBe(true);
  });

  it('没有整页刷新或跳转调用', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => HARD_NAVIGATION.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('没有「请刷新」这类提示文案', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => REFRESH_PROMPT.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
