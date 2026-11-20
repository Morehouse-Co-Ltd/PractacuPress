/**
 * 请求日志查看器的客户端约束与地址栏状态。
 *
 * 服务端（`GET /system/logs`）只接受 1–100 的 `limit`，超过 100 会返回 400。
 * 之前页面固定传 200，于是「请求日志」永远显示读取失败；把上限收在一个常量里，
 * 调用方就不会再各自写一个魔法数字。
 */
export const REQUEST_LOG_LIMIT = 100;

/** 日志页当前展示的来源；地址栏里用 `?source=request` 直达请求日志。 */
export type LogSource = 'audit' | 'request';

/** 把任意调用方给的 limit 收进服务端契约范围。 */
export function clampRequestLogLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return REQUEST_LOG_LIMIT;
  return Math.min(REQUEST_LOG_LIMIT, Math.max(1, Math.trunc(value)));
}

/** 只认精确的 `request`，未知/空值回退到网站日志。 */
export function logSourceFromSearch(search: URLSearchParams): LogSource {
  return search.get('source') === 'request' ? 'request' : 'audit';
}
