import type { BlockInstance, BuilderDevice, Me } from '../types';

/** 访客在这次渲染里扮演的角色。 */
export type ViewerRole = 'guest' | 'member' | 'admin';

export interface VisibilityContext {
  device: BuilderDevice;
  role: ViewerRole;
  now: Date;
}

/** 从登录态推出角色。个人站点里所有登录账户都是管理员，由 me.role 直接决定。 */
export function roleFromSession(me: Me | null): ViewerRole {
  if (!me) return 'guest';
  return me.role === 'platform_admin' || me.role === 'site_admin' ? 'admin' : 'member';
}

function dateOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 条件显示求值。
 *
 * 三组条件全部满足才可见；缺某组表示该组不设限。坏日期按"没写"处理——
 * 一个手滑的日期不该让整块内容从站点上消失。
 *
 * 注意：这是排版工具，不是访问控制。站点设计文档对所有访客是同一份公开 JSON，
 * 用 visible 藏内容不构成安全边界。
 */
export function isVisibleAt(
  block: Pick<BlockInstance, 'visible'>,
  ctx: VisibilityContext,
): boolean {
  const visible = block.visible;
  if (!visible) return true;

  if (visible.devices?.length && !visible.devices.includes(ctx.device)) return false;
  if (visible.roles?.length && !visible.roles.includes(ctx.role)) return false;

  const now = ctx.now.getTime();
  const from = dateOf(visible.from);
  const to = dateOf(visible.to);
  if (from !== null && now < from) return false;
  // to 是「含当天」：把结束日期当作那天的最后一毫秒。
  if (to !== null && now > to + 86_399_999) return false;
  return true;
}
