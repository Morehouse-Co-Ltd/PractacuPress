import type { SiteKind, WebConfig } from '../types';
import { labelMap } from './i18n/labels';

export const SITE_KIND_LABEL = labelMap<SiteKind>({
  personal: '个人博客',
  community: '社区站点',
});

/** 站点形态存在本地安装配置里：契约 v0.1.0 的 Site 没有对应字段。 */
export function siteKindOf(config: Pick<WebConfig, 'site_kind'>): SiteKind {
  return config.site_kind === 'personal' ? 'personal' : 'community';
}

export function isPersonalSite(config: Pick<WebConfig, 'site_kind'>): boolean {
  return siteKindOf(config) === 'personal';
}

/**
 * 个人博客不接受自助注册：账户由站长在后台「成员与角色」里创建。
 * 已经存在的账户不会被删除，切换到个人博客后仍然可以登录。
 */
export function registrationOpen(config: Pick<WebConfig, 'site_kind'>): boolean {
  return !isPersonalSite(config);
}

/** 个人博客下，所有账户都能进入后台并获得全部权限。 */
export function adminAccessForKind(kind: SiteKind): boolean {
  return kind === 'personal';
}
