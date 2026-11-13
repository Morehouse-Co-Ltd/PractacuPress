import { describe, expect, it } from 'vitest';
import type { CapabilityId } from '../types';
import {
  ADMIN_CAPABILITIES,
  adminEntryAllowed,
  adminEditorPath,
  adminTargetForWritePath,
  hasAdminCapability,
  isAdminHref,
  writeTargetForAdminPath,
  writingEntryPath,
  writingPath,
} from './adminAccess';
import { DEFAULT_PERMISSIONS } from './permissions';

function canFrom(capabilities: CapabilityId[]) {
  return (capability: CapabilityId) => capabilities.includes(capability);
}

const MEMBER_CAPS: CapabilityId[] = ['read_content', 'comment', 'write_content'];
const MODERATOR_CAPS: CapabilityId[] = [
  'read_content',
  'comment',
  'write_content',
  'moderate_content',
  'moderate_comment',
];

describe('管理后台入口', () => {
  it('把写稿算作前台能力，不算后台身份', () => {
    expect(ADMIN_CAPABILITIES).not.toContain('write_content');
    expect(hasAdminCapability(canFrom(MEMBER_CAPS))).toBe(false);
  });

  it('默认成员组只有写稿能力，进不了后台', () => {
    expect(
      adminEntryAllowed({
        settings: DEFAULT_PERMISSIONS,
        group: 'member',
        can: canFrom(MEMBER_CAPS),
      }),
    ).toBe(false);
  });

  it('默认审核员组开启了后台入口，可以进后台', () => {
    expect(
      adminEntryAllowed({
        settings: DEFAULT_PERMISSIONS,
        group: 'moderator',
        can: canFrom(MODERATOR_CAPS),
      }),
    ).toBe(true);
  });

  it('站长关掉「进入管理后台」后，审核员也进不去', () => {
    const settings = {
      ...DEFAULT_PERMISSIONS,
      moderator: { ...DEFAULT_PERMISSIONS.moderator, admin_access: false },
    };
    expect(
      adminEntryAllowed({ settings, group: 'moderator', can: canFrom(MODERATOR_CAPS) }),
    ).toBe(false);
  });

  it('只打开后台入口、没有任何后台能力时仍然进不去', () => {
    const settings = {
      ...DEFAULT_PERMISSIONS,
      member: { ...DEFAULT_PERMISSIONS.member, admin_access: true },
    };
    expect(
      adminEntryAllowed({ settings, group: 'member', can: canFrom(MEMBER_CAPS) }),
    ).toBe(false);
  });

  it('最高管理员组始终可以进入后台', () => {
    expect(
      adminEntryAllowed({
        settings: DEFAULT_PERMISSIONS,
        group: 'owner',
        can: canFrom([...ADMIN_CAPABILITIES]),
      }),
    ).toBe(true);
  });
});

describe('写作台与后台编辑器的地址', () => {
  it('生成写作台地址', () => {
    expect(writingPath('article')).toBe('/write/new/article');
    expect(writingPath('post')).toBe('/write/new/post');
    expect(writingPath('article', 'cnt_1')).toBe('/write/article/cnt_1');
  });

  it('生成后台编辑器地址', () => {
    expect(adminEditorPath('article')).toBe('/admin/content/new/article');
    expect(adminEditorPath('post', 'cnt_1')).toBe('/admin/content/post/cnt_1');
  });

  it('把后台编辑器地址翻译成写作台地址', () => {
    expect(writeTargetForAdminPath('/admin/content/new/article')).toBe('/write/new/article');
    expect(writeTargetForAdminPath('/admin/content/post/cnt_9')).toBe('/write/post/cnt_9');
  });

  it('非编辑器地址不翻译', () => {
    expect(writeTargetForAdminPath('/admin/content')).toBeNull();
    expect(writeTargetForAdminPath('/admin/settings')).toBeNull();
    expect(writeTargetForAdminPath('/admin/docs')).toBeNull();
    expect(writeTargetForAdminPath('/admin/content/new/page')).toBeNull();
    expect(writeTargetForAdminPath('/admin/content/page/abc')).toBeNull();
    expect(writeTargetForAdminPath('/admin/content/new/article/extra')).toBeNull();
  });

  it('把写作台地址送回后台编辑器', () => {
    expect(adminTargetForWritePath('/write/new/article')).toBe('/admin/content/new/article');
    expect(adminTargetForWritePath('/write/article/cnt_2')).toBe('/admin/content/article/cnt_2');
    expect(adminTargetForWritePath('/write')).toBeNull();
  });

  it('内容 id 在两种地址之间往返编码一致', () => {
    expect(writeTargetForAdminPath('/admin/content/article/cnt%2F1')).toBe('/write/article/cnt%2F1');
    expect(adminTargetForWritePath('/write/article/cnt%2F1')).toBe('/admin/content/article/cnt%2F1');
  });

  it('「写文章」入口按身份分流', () => {
    expect(writingEntryPath('article', true)).toBe('/admin/content/new/article');
    expect(writingEntryPath('article', false)).toBe('/write/new/article');
  });
});

describe('后台入口地址识别', () => {
  it('默认入口与它的子路径都算后台', () => {
    expect(isAdminHref('/admin')).toBe(true);
    expect(isAdminHref('/admin/')).toBe(true);
    expect(isAdminHref('/admin/content/new/article')).toBe(true);
    expect(isAdminHref('/admin?from=footer')).toBe(true);
    expect(isAdminHref('/ADMIN/settings')).toBe(true);
  });

  it('站点前台地址与相似前缀不算后台', () => {
    expect(isAdminHref('/')).toBe(false);
    expect(isAdminHref('/articles')).toBe(false);
    expect(isAdminHref('/administrator')).toBe(false);
    expect(isAdminHref('/write/new/article')).toBe(false);
    expect(isAdminHref('https://example.com/admin')).toBe(false);
    expect(isAdminHref('')).toBe(false);
  });

  it('自定义后台入口也按同一规则识别', () => {
    expect(isAdminHref('/manage', '/manage')).toBe(true);
    expect(isAdminHref('/manage/users', '/manage/')).toBe(true);
    expect(isAdminHref('/admin', '/manage')).toBe(false);
    expect(isAdminHref('/manage-notes', '/manage')).toBe(false);
  });
});
