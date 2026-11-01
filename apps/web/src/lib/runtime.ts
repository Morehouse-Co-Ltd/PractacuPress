/**
 * 站点运行时信息：访问端口与静态服务器能力。
 *
 * 端口由 `apps/web/scripts/serve.mjs` 提供（npm start）。开发服务器（Vite）
 * 没有运行时接口，此时读取失败，界面按“启动时确定”处理。
 */

export interface RuntimeApiInfo {
  /** 启动器是否托管了本机 API 进程。 */
  managed: boolean;
  /** API 是否已通过 /readyz 检查。 */
  ready: boolean;
  base?: string;
  pid?: number;
  /** 随包附带了 Rust 安全服务并且已启动。 */
  security?: boolean;
  data_dir?: string;
  log?: string;
  /** 启动失败时的原因（多行，直接展示）。 */
  error?: string;
}

export interface RuntimeInfo {
  mode: 'static';
  port: number;
  origin: string;
  pid: number;
  started_at: string;
  dist_ready: boolean;
  /** 启动器本次的运行方式；Vite / serve.mjs 没有这两个字段。 */
  runtime_mode?: 'demo' | 'live';
  api?: RuntimeApiInfo;
}

export interface PortChangeResult {
  ok: boolean;
  port: number;
  previous: number;
  origin: string;
  unchanged?: boolean;
  /** 旧地址的浏览器数据交给新地址时的一次性令牌。 */
  import_token?: string;
}

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** 当前页面实际使用的端口；地址里省略端口时按协议取默认值。 */
export function currentPort(): number {
  if (typeof window === 'undefined') return 80;
  if (window.location.port) return Number(window.location.port);
  return DEFAULT_PORT[window.location.protocol] ?? 80;
}

/** 80 / 443 不写端口号，和浏览器地址栏保持一致。 */
export function originForPort(port: number): string {
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
  const fallback = protocol === 'https' ? 443 : 80;
  let host = window.location.hostname;
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `${protocol}://${host}${port === fallback ? '' : `:${port}`}`;
}

export function formatOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

export async function readRuntime(): Promise<RuntimeInfo | null> {
  try {
    const res = await fetch('/__pp/runtime', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(1500)
          : undefined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<RuntimeInfo>;
    if (data?.mode !== 'static' || typeof data.port !== 'number' || typeof data.origin !== 'string') {
      return null;
    }
    return data as RuntimeInfo;
  } catch {
    return null;
  }
}

export async function changePort(
  port: number,
  state?: Record<string, string>,
): Promise<PortChangeResult> {
  const res = await fetch('/__pp/runtime/port', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(state ? { port, state } : { port }),
  });
  const body = (await res.json().catch(() => null)) as
    | (Partial<PortChangeResult> & { message?: string })
    | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.message || '端口切换失败，请稍后再试。');
  }
  return body as PortChangeResult;
}

const CONFIG_KEY = 'pp.web.config.v1';
const IMPORT_PARAM = 'pp_import';

/** 当前地址下属于本站的浏览器数据（安装配置、演示数据、活动记录）。 */
export function collectLocalState(): Record<string, string> {
  const items: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('pp.')) continue;
      const value = localStorage.getItem(key);
      if (typeof value === 'string') items[key] = value;
    }
  } catch {
    /* 无痕模式或禁用存储：不迁移，按首次打开处理 */
  }
  return items;
}

/**
 * 换端口后浏览器存储按地址隔离。打开新地址时读取一次性迁移令牌，
 * 把旧地址的配置与演示数据写回来，避免换端口等于重装。
 */
export async function importMovedSite(): Promise<void> {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get(IMPORT_PARAM) || '';
  if (!/^[a-f0-9]{32}$/.test(token)) return;

  params.delete(IMPORT_PARAM);
  const search = params.toString();
  const clean = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;

  try {
    // 新地址已经有站点时保持原样：那里可能是另一份独立的安装。
    if (!localStorage.getItem(CONFIG_KEY)) {
      const res = await fetch(`/__pp/state/${token}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (res.ok) {
        const data = (await res.json()) as { items?: Record<string, string> };
        for (const [key, value] of Object.entries(data.items ?? {})) {
          if (key.startsWith('pp.') && typeof value === 'string') {
            localStorage.setItem(key, value);
          }
        }
      }
    }
  } catch {
    /* 迁移失败就按普通首次打开处理 */
  } finally {
    window.history.replaceState(null, '', clean);
  }
}
