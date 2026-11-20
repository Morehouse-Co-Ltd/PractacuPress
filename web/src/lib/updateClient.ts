import type { SiteUpdateManifest, SiteUpdateSettings } from '../types';
import { APP_VERSION_MANIFEST } from './appVersion';
import { manifestUrlOf, parseUpdateManifest } from './siteUpdate';

/**
 * 更新检查的客户端。
 *
 * 「用户在使用的时候服务端会尝试从 GitHub 仓库抓取 JSON 来做比较」——这一步由本站
 * 服务端完成：`GET /__pp/update?source=…` 会用服务端自己的 HTTP 客户端去读清单，
 * 再把结果连同本机版本一起返回。浏览器直连清单地址只是兜底（例如 Vite 开发服务器
 * 或只有静态文件的旧部署），此时的 CORS 与超时都由浏览器负责，体验差一档。
 *
 * 这里只负责「发请求 + 校验响应」，不碰 React；结果统一收敛成 `UpdateCheck`。
 */

/** 服务端更新接口：只有 `npm start` 的静态服务实现它，Go API 没有这个端点。 */
export const UPDATE_ENDPOINT = '/__pp/update';

/** 更新检查失败的原因；页面据此给出不同提示。 */
export type UpdateCheckErrorCode =
  | 'no_source'
  /** 服务端与浏览器都拿不到清单，例如纯静态托管。 */
  | 'unsupported'
  /** 网络错误、超时或跨域被拒。 */
  | 'network'
  /** 响应不是合法 JSON 或缺少核心字段。 */
  | 'invalid'
  /** 服务端返回了非 2xx 的错误码。 */
  | 'http';

export class UpdateCheckError extends Error {
  readonly code: UpdateCheckErrorCode;

  constructor(code: UpdateCheckErrorCode, message: string) {
    super(message);
    this.name = 'UpdateCheckError';
    this.code = code;
  }
}

/** 一次成功的检查结果。 */
export interface UpdateCheck {
  /** 本机清单；服务端没读到、又拿不到前端版本时用内置值。 */
  local: SiteUpdateManifest;
  remote: SiteUpdateManifest;
  /** 实际读取的清单地址。 */
  source: string;
  /** 检查时间（ISO 字符串）。 */
  checked_at: string;
  /** 是否由本站服务端抓取；false 表示浏览器直连。 */
  server_side: boolean;
}

/** 服务端 `/__pp/update` 的响应体（只声明客户端用到的字段）。 */
interface ServerUpdateBody {
  ok?: boolean;
  source?: string;
  fetched_at?: string;
  local?: unknown;
  remote?: unknown;
  update_available?: boolean;
  reason?: string;
  code?: string;
  message?: string;
}

const SERVER_TIMEOUT_MS = 6000;
const DIRECT_TIMEOUT_MS = 8000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { name?: string }).name === 'TimeoutError')
  );
}

/** 失败提示文案；返回的是中文键，调用方再套 `t()`。 */
export function updateErrorMessage(code: UpdateCheckErrorCode): string {
  switch (code) {
    case 'no_source':
      return '还没有选择更新源。';
    case 'unsupported':
      return '当前服务器不支持服务端检查更新，浏览器也无法直接读取版本清单。';
    case 'network':
      return '无法连接更新源，请检查网络后重试。';
    case 'invalid':
      return '更新源返回的不是有效的版本清单。';
    default:
      return '更新检查失败，请稍后再试。';
  }
}

/** 读取 JSON；非 JSON 响应返回 null，交给调用方决定是「不支持」还是「清单无效」。 */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 检查更新。
 *
 * 先问本站服务端，服务端不可用（返回 HTML 的 404、连接被拒）时再让浏览器直连清单。
 * 两种情况都不成功才抛错，且错误码能区分「服务器不支持」「网络」「清单无效」。
 */
export async function checkForUpdate(
  settings: Pick<SiteUpdateSettings, 'server_url'>,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<UpdateCheck> {
  const source = manifestUrlOf(settings.server_url);
  if (!settings.server_url.trim()) {
    throw new UpdateCheckError('no_source', updateErrorMessage('no_source'));
  }
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? (() => Date.now());

  const serverResult = await askServer(doFetch, source);
  if (serverResult) {
    const remote = parseUpdateManifest(serverResult.remote);
    if (!remote) {
      throw new UpdateCheckError('invalid', updateErrorMessage('invalid'));
    }
    const local = parseUpdateManifest(serverResult.local) ?? APP_VERSION_MANIFEST;
    return {
      local,
      remote,
      source: typeof serverResult.source === 'string' && serverResult.source ? serverResult.source : source,
      checked_at:
        typeof serverResult.fetched_at === 'string' && serverResult.fetched_at
          ? serverResult.fetched_at
          : new Date(now()).toISOString(),
      server_side: true,
    };
  }

  // 服务端没有这个接口：退回浏览器直连。清单地址是 GitHub 原始文件时带 CORS 头。
  let res: Response;
  try {
    res = await doFetch(source, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: timeoutSignal(DIRECT_TIMEOUT_MS),
    });
  } catch {
    throw new UpdateCheckError('network', updateErrorMessage('network'));
  }
  if (!res.ok) {
    throw new UpdateCheckError('http', `${updateErrorMessage('http')} (${res.status})`);
  }
  const remote = parseUpdateManifest(await readJson(res));
  if (!remote) {
    throw new UpdateCheckError('invalid', updateErrorMessage('invalid'));
  }
  return {
    local: APP_VERSION_MANIFEST,
    remote,
    source,
    checked_at: new Date(now()).toISOString(),
    server_side: false,
  };
}

/**
 * 问本站服务端。
 *
 * 返回 null 表示「这台服务器没有更新接口」，调用方才该去直连。只有响应明确是本站
 * 的 JSON 错误（带 `code`）时才直接抛错：那是服务端拒绝或抓取失败的真实原因，
 * 比让浏览器再试一次更有用。
 */
async function askServer(
  doFetch: typeof fetch,
  source: string,
): Promise<ServerUpdateBody | null> {
  let res: Response;
  try {
    res = await doFetch(`${UPDATE_ENDPOINT}?source=${encodeURIComponent(source)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: timeoutSignal(SERVER_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new UpdateCheckError('network', updateErrorMessage('network'));
    }
    return null;
  }
  const body = (await readJson(res)) as ServerUpdateBody | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  if (!res.ok || body.ok === false) {
    // 老版本服务端没有这个接口时会返回统一的 JSON 404；那种情况交给浏览器直连，
    // 而不是把“接口不存在”当成一次失败的检查。
    if (res.status === 404 && body.code === 'not_found') return null;
    const details = typeof body.message === 'string' ? body.message : '';
    throw new UpdateCheckError(
      'http',
      details || `${updateErrorMessage('http')} (${res.status})`,
    );
  }
  if (!parseUpdateManifest(body.remote)) {
    throw new UpdateCheckError('invalid', updateErrorMessage('invalid'));
  }
  return body;
}

/** 手动更新的服务端接口：把一个已经解压好的构建目录换上去。 */
export const UPDATE_APPLY_ENDPOINT = '/__pp/update/apply';

export interface UpdateApplyResult {
  /** 换上去的版本号。 */
  version: string;
  /** 换之前的版本号；第一次切换时为空串。 */
  previous: string;
  /** 新构建的标识（目录名）。 */
  active: string;
}

/**
 * 手动更新：把本机已解压的构建目录交给服务端换上。
 *
 * 服务端（`npm start` 的静态服务）在**不停进程**的前提下原子切换站点文件，其他设备与访客的
 * 请求不受影响；已经在读的页面继续用旧资源（服务端保留上一份构建做兜底），下一次
 * 加载才会拿到新版本。Go API 构建没有这个端点，调用会返回不支持。真正的“自动下载并安装”
 * 属于还没实现的服务端部分。
 */
export async function applyUpdateFromDir(
  dir: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<UpdateApplyResult> {
  const value = dir.trim();
  if (!value) {
    throw new UpdateCheckError('invalid', updateErrorMessage('http'));
  }
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let res: Response;
  try {
    res = await doFetch(UPDATE_APPLY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dir: value }),
      signal: timeoutSignal(SERVER_TIMEOUT_MS),
    });
  } catch {
    throw new UpdateCheckError('network', updateErrorMessage('network'));
  }
  const body = (await readJson(res)) as
    | (Partial<UpdateApplyResult> & { ok?: boolean; code?: string; message?: string })
    | null;
  if (!res.ok || !body || body.ok === false) {
    throw new UpdateCheckError(
      'http',
      (body && typeof body.message === 'string' && body.message) ||
        `${updateErrorMessage('http')} (${res.status})`,
    );
  }
  return {
    version: typeof body.version === 'string' ? body.version : '',
    previous: typeof body.previous === 'string' ? body.previous : '',
    active: typeof body.active === 'string' ? body.active : '',
  };
}
