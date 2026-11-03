import type { Site } from '../types';
import { ApiError } from './api';

/**
 * 站点是否开放自助注册（O-3）。
 *
 * 服务端在 Site 与 setup/status 上返回 `registration_open`。旧后端、升级前的浏览器
 * 缓存与旧演示数据都没有这个字段，一律按「开放」处理：误关注册的代价远高于多显示
 * 一个注册入口。个人博客固定关闭注册由 site_kind 单独判断，不依赖这个字段。
 */
export function registrationOpen(
  site: Pick<Site, 'registration_open'> | null | undefined,
): boolean {
  return site?.registration_open !== false;
}

/**
 * 识别「注册已关闭」的服务端拒绝：403 `permission_denied` +
 * `details.reason = registration_closed`。
 *
 * 注册页据此显示「本站暂未开放注册」，而不是把服务端 problem 的原始文案抛给访客。
 */
export function isRegistrationClosedError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.problem.details?.reason === 'registration_closed';
}
