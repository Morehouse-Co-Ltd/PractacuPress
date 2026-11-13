import { describe, expect, it } from 'vitest';

/**
 * 回归闸门：用户组编辑链路不许依赖整页刷新。
 *
 * 用户的要求是「改用户组时页面不弹刷新、保持完好的查看状态」。权限矩阵、改名与
 * 新建组都走局部状态 + PUT，不需要也不应该重载页面。这里把相关文件钉住，避免以后
 * 有人用 `location.reload()` 或「请刷新」提示把现场恢复成旧的交互。
 */

const sources = import.meta.glob(
  '../{pages/admin/Permissions.tsx,pages/admin/Members.tsx,lib/usePermissions.ts,lib/permissions.ts}',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** 会让浏览器整页重载 / 跳转的写法。 */
const HARD_NAVIGATION =
  /location\s*\.\s*(reload|assign|replace)\s*\(|location\s*\.\s*href\s*=|document\s*\.\s*location\s*=/;

const REFRESH_PROMPT = /请刷新|刷新页面后重试|刷新一下页面|刷新后重试/;

describe('用户组编辑链路不依赖整页刷新', () => {
  it('扫描到全部相关文件', () => {
    const paths = Object.keys(sources);
    expect(paths).toHaveLength(4);
    expect(paths.some((path) => path.endsWith('pages/admin/Permissions.tsx'))).toBe(true);
    expect(paths.some((path) => path.endsWith('pages/admin/Members.tsx'))).toBe(true);
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
