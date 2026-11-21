import type {
  StorageAllocationEntry,
  StorageApplyRequest,
  StorageApplyStrategy,
  StorageDriver,
  StorageScope,
  StorageScopeAllocation,
  StorageSettings,
  StorageStatus,
  StorageStrategy,
  WebConfig,
} from '../types';
import { t } from './i18n';
import { settingInt, settingText } from './settings';

/**
 * 媒体储存策略。
 *
 * 模型是一串用户自己维护的命名策略（storage strategy）：每套策略描述一个
 * 存储目标（本地目录或 S3 兼容的云对象存储），四个用途（文章媒体 / 站点图片 /
 * 用户头像 / 用户数据与附件）各自挑一套或多套。平台管理员保存后，页面把设置交给
 * `PUT /system/storage` 立即应用：API 写进服务器的 `data/storage-settings.json`
 * 并马上换用（优先于 `.env` 里的 `STORAGE_*`），配额与多策略切换也由服务端在
 * 写入时执行，无需重启，已上传的文件不会自动搬运。
 *
 * 没有运行期应用权限、演示模式或旧后端时，页面只把选择翻译成可直接粘贴的
 * `.env` 片段，由部署方自己写进服务器再重启。
 *
 * 部署片段对应的服务器契约（`internal/platform/config/config.go`）只有**一套全局**
 * `STORAGE_DRIVER` + 一套全局 S3 凭据，外加每个用途可选的
 * `STORAGE_<SCOPE>_DRIVER|LOCAL_DIR|S3_BUCKET|S3_PREFIX` 覆盖。于是生成片段时
 * 把「被最多用途使用的策略」当作全局策略（数量并列取数组里靠前的），其余用途
 * 只写自己的覆盖变量。多套云策略因此共用同一套 endpoint / 区域 / Access Key。
 *
 * 默认值与 `config.go` 及根目录 `.env.example` 保持一致：
 * `STORAGE_DRIVER=local`、`STORAGE_DIR=./data/media`。
 */

/** 有独立储存设置的用途，顺序也用于生成片段与页面卡片。 */
export const STORAGE_SCOPES: readonly StorageScope[] = [
  'content',
  'site',
  'avatar',
  'attachment',
];

/** 最多允许保存几套策略；再多的话 .env 片段会难维护。 */
export const MAX_STRATEGIES = 8;

/** 策略名称的最大长度（字符数，不是字节数）。 */
export const MAX_STRATEGY_NAME = 40;

/** 单个用途最多可以排多少套策略；再多会让分配界面难以阅读。 */
export const MAX_ALLOCATION_ENTRIES = 8;

/** 单套策略在单个用途下的容量上限（GB）；0 表示不限。 */
export const MAX_ALLOCATION_QUOTA_GB = 1_000_000;

/** 正文长度上限；储存策略可以调低，不能超过服务端的绝对上限。 */
export const MAX_CONTENT_SOURCE_CHARS = 1_000_000;

/** 旧配置缺省时应显示的默认容量上限。 */
const DEFAULT_ALLOCATION_QUOTA_GB = 0;

/** 本地存储的默认目录；与 API 的 STORAGE_DIR 默认值一致。 */
export const DEFAULT_LOCAL_DIR = './data/media';

/** S3 SDK 的默认区域；留空时后端也按这个值处理。 */
export const DEFAULT_S3_REGION = 'us-east-1';

/** 默认策略的稳定 id：旧配置迁移时本地全局也用它。 */
export const DEFAULT_STRATEGY_ID = 'local';

/** id 只允许小写字母、数字、下划线与连字符，方便直接当环境变量注释的锚点。 */
const ID_PATTERN = /^[a-z0-9_-]+$/;

function text(value: unknown, fallback: string, max = 300): string {
  return settingText(value, fallback, max).trim();
}

/** 去掉结尾斜杠，避免生成片段里出现 `https://host//` 或 `./data/media/`。 */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 桶名与前缀两侧的斜杠都去掉；后端会自己处理拼接。 */
function withoutEdgeSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function readDriver(value: unknown): StorageDriver {
  return value === 's3' ? 's3' : 'local';
}

/** 用途的默认展示名；也用于把旧配置的分用途覆盖命名成一套策略。 */
export function scopeLabel(scope: StorageScope): string {
  switch (scope) {
    case 'content':
      return t('文章媒体');
    case 'site':
      return t('站点图片');
    case 'avatar':
      return t('用户头像');
    case 'attachment':
      return t('用户数据与附件');
  }
}

/** 驱动的展示名：与页面上「类型」切换的文案是同一套。 */
export function storageDriverLabel(driver: StorageDriver): string {
  return driver === 's3' ? t('云对象存储') : t('本地储存');
}

/** 一套空白策略；只用于「新建」弹窗的初始值。 */
export function emptyStrategy(): StorageStrategy {
  return {
    id: '',
    name: '',
    driver: 'local',
    local_dir: DEFAULT_LOCAL_DIR,
    s3_bucket: '',
    s3_prefix: '',
    s3_endpoint: '',
    s3_region: DEFAULT_S3_REGION,
    s3_access_key: '',
    s3_public_base_url: '',
  };
}

/** 默认的那一套「本地储存」。 */
export function defaultLocalStrategy(): StorageStrategy {
  return { ...emptyStrategy(), id: DEFAULT_STRATEGY_ID, name: t('本地储存') };
}

/** 一个用途的空白分配：一套策略、不限容量、按顺序切换。 */
export function emptyAllocation(strategyId: string): StorageScopeAllocation {
  return {
    mode: 'single',
    entries: [{ strategy_id: strategyId, quota_gb: DEFAULT_ALLOCATION_QUOTA_GB }],
    overflow: 'switch',
  };
}

/** 全新安装的默认设置：只有一套「本地储存」，四个用途都指向它。 */
export function defaultStorage(): StorageSettings {
  const strategy = defaultLocalStrategy();
  return {
    strategies: [strategy],
    scopes: {
      content: strategy.id,
      site: strategy.id,
      avatar: strategy.id,
      attachment: strategy.id,
    },
    allocations: {
      content: emptyAllocation(strategy.id),
      site: emptyAllocation(strategy.id),
      avatar: emptyAllocation(strategy.id),
      attachment: emptyAllocation(strategy.id),
    },
    max_upload_mb: 25,
    max_content_chars: MAX_CONTENT_SOURCE_CHARS,
  };
}

/** 生成一个没被占用的策略 id。 */
export function createStrategyId(strategies: StorageStrategy[]): string {
  const used = new Set(strategies.map((strategy) => strategy.id));
  let index = 1;
  let id = `str_${index}`;
  while (used.has(id)) {
    index += 1;
    id = `str_${index}`;
  }
  return id;
}

/** 收敛一个策略 id：小写、非法字符变连字符、空值回退到 `str_<n>`。 */
function sanitizeId(raw: unknown, index: number): string {
  const source = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const slug = source.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `str_${index + 1}`;
}

/**
 * 把任意来源的单套策略收敛成合法形状。
 *
 * `id` 由调用方给定：新建策略时页面用 `createStrategyId()` 生成，迁移旧配置时
 * 用固定的稳定 id。名称留空时按类型给一个可读的默认名，保证「名称必填」的
 * 老配置不会变成空行。
 */
export function normalizeStrategy(
  raw: Partial<StorageStrategy> | undefined | null,
  id: string,
): StorageStrategy {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const driver = readDriver(source.driver);
  const name = text(source.name, '', MAX_STRATEGY_NAME);
  const region = text(source.s3_region, DEFAULT_S3_REGION, 80);
  return {
    id: ID_PATTERN.test(id) ? id : sanitizeId(id, 0),
    name: name || storageDriverLabel(driver),
    driver,
    local_dir: withoutTrailingSlash(text(source.local_dir, '', 300)),
    s3_bucket: withoutEdgeSlashes(text(source.s3_bucket, '', 120)),
    s3_prefix: withoutEdgeSlashes(text(source.s3_prefix, '', 200)),
    s3_endpoint: withoutTrailingSlash(text(source.s3_endpoint, '', 300)),
    s3_region: region || DEFAULT_S3_REGION,
    s3_access_key: text(source.s3_access_key, '', 200),
    s3_public_base_url: withoutTrailingSlash(text(source.s3_public_base_url, '', 300)),
  };
}

/**
 * 把任意来源的单个用途分配收敛成合法形状。
 *
 * - 只保留引用得到、且没有重复的策略；
 * - `quota_gb` 取值 0–`MAX_ALLOCATION_QUOTA_GB`，0 表示不限；
 * - 一个合法策略都没有时回落到 `fallbackId`，保证每个用途至少有一套；
 * - 单策略模式也保留多出来的 entries：切回多策略时不用重新添加。
 */
export function normalizeAllocation(
  raw: unknown,
  fallbackId: string,
  strategies: StorageStrategy[],
): StorageScopeAllocation {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const validIds = new Set(strategies.map((strategy) => strategy.id));
  const rawEntries = Array.isArray(source.entries) ? source.entries : [];
  const entries: StorageAllocationEntry[] = [];
  const seen = new Set<string>();

  for (const item of rawEntries) {
    if (entries.length >= MAX_ALLOCATION_ENTRIES) break;
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.strategy_id === 'string' ? entry.strategy_id : '';
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      strategy_id: id,
      quota_gb: settingInt(
        entry.quota_gb,
        DEFAULT_ALLOCATION_QUOTA_GB,
        0,
        MAX_ALLOCATION_QUOTA_GB,
      ),
    });
  }

  if (!entries.length) {
    entries.push({
      strategy_id: fallbackId,
      quota_gb: DEFAULT_ALLOCATION_QUOTA_GB,
    });
  }

  return {
    mode: source.mode === 'quota' ? 'quota' : 'single',
    entries,
    overflow: source.overflow === 'stop' ? 'stop' : 'switch',
  };
}

/** 每个用途的主策略 id（多策略时取排在最前的一套）。 */
function scopeIdsFromAllocations(
  allocations: Record<StorageScope, StorageScopeAllocation>,
): Record<StorageScope, string> {
  const scopes = {} as Record<StorageScope, string>;
  for (const scope of STORAGE_SCOPES) {
    const allocation = allocations[scope];
    scopes[scope] = allocation?.entries[0]?.strategy_id ?? DEFAULT_STRATEGY_ID;
  }
  return scopes;
}

/** 从旧结构或新结构读取一个用途的完整分配。 */
function readAllocation(
  source: Record<string, unknown> | undefined,
  scope: StorageScope,
  fallbackId: string,
  strategies: StorageStrategy[],
): StorageScopeAllocation {
  const rawAllocations =
    source && source.allocations && typeof source.allocations === 'object'
      ? (source.allocations as Record<string, unknown>)
      : undefined;
  return normalizeAllocation(rawAllocations?.[scope], fallbackId, strategies);
}

/**
 * 一个用途的完整分配。
 *
 * 旧配置（或手写的测试对象）没有 `allocations` 时，按 `scopes` 回退成单策略；
 * 这样调用方永远不需要判断字段是否存在。
 */
export function scopeAllocation(
  settings: StorageSettings,
  scope: StorageScope,
): StorageScopeAllocation {
  const raw = settings.allocations?.[scope];
  if (raw && Array.isArray(raw.entries) && raw.entries.length) {
    return raw;
  }
  return emptyAllocation(settings.scopes[scope]);
}

/**
 * 一个用途实际会使用的策略 id（按写入顺序）。
 *
 * 单策略模式只返回第一套；多策略模式返回整个顺序列表。已经不存在于
 * `strategies` 里的 id 会被过滤掉，由调用方回落到第一套。
 */
export function scopeStrategyIds(
  settings: StorageSettings,
  scope: StorageScope,
): string[] {
  const allocation = scopeAllocation(settings, scope);
  const entries =
    allocation.mode === 'single' ? allocation.entries.slice(0, 1) : allocation.entries;
  const validIds = new Set(settings.strategies.map((strategy) => strategy.id));
  const ids = entries
    .map((entry) => entry.strategy_id)
    .filter((id) => validIds.size === 0 || validIds.has(id));
  return ids.length ? ids : [settings.strategies[0]?.id ?? DEFAULT_STRATEGY_ID];
}

/** 引用了某套策略的所有用途（用于策略卡片与删除确认）。 */
export function scopesUsingStrategy(
  settings: StorageSettings,
  strategyId: string,
): StorageScope[] {
  return STORAGE_SCOPES.filter((scope) =>
    scopeStrategyIds(settings, scope).includes(strategyId),
  );
}

/** id 去重：保序，重复的加 `-2`、`-3` 后缀。 */
function uniqueIds(strategies: StorageStrategy[]): StorageStrategy[] {
  const used = new Set<string>();
  return strategies.map((strategy) => {
    let id = strategy.id;
    let index = 2;
    while (used.has(id)) {
      id = `${strategy.id}-${index}`;
      index += 1;
    }
    used.add(id);
    return id === strategy.id ? strategy : { ...strategy, id };
  });
}

/** 名称去重：保序，重复的加 ` 2`、` 3` 后缀，并保持长度上限。 */
function uniqueNames(strategies: StorageStrategy[]): StorageStrategy[] {
  const used = new Set<string>();
  return strategies.map((strategy) => {
    let name = strategy.name;
    let index = 2;
    while (used.has(name)) {
      const suffix = ` ${index}`;
      name = `${strategy.name.slice(0, Math.max(1, MAX_STRATEGY_NAME - suffix.length)).trimEnd()}${suffix}`;
      index += 1;
    }
    used.add(name);
    return name === strategy.name ? strategy : { ...strategy, name };
  });
}

/** 收尾：id / 名称去重，再按上限截断。截断后由调用方把用途回落到第一套。 */
function settleStrategies(strategies: StorageStrategy[]): StorageStrategy[] {
  return uniqueNames(uniqueIds(strategies)).slice(0, MAX_STRATEGIES);
}

/** 用途指向的策略；id 不存在（数据坏掉）时回落到第一套。 */
export function findStrategy(
  settings: StorageSettings,
  id: string | undefined,
): StorageStrategy {
  const strategies = settings.strategies.length
    ? settings.strategies
    : defaultStorage().strategies;
  return strategies.find((strategy) => strategy.id === id) ?? strategies[0];
}

/** 策略「位置」的简短展示：本地 → 目录，云 → 桶 / 前缀。 */
export function strategyLocation(strategy: StorageStrategy): string {
  if (strategy.driver !== 's3') return strategy.local_dir || DEFAULT_LOCAL_DIR;
  if (!strategy.s3_bucket) return t('未填写桶');
  return strategy.s3_prefix
    ? `${strategy.s3_bucket}/${strategy.s3_prefix}`
    : strategy.s3_bucket;
}

/** 每个策略被几个用途引用；用于选全局策略与页面徽标。 */
export function scopeUsageCounts(settings: StorageSettings): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const strategy of settings.strategies) counts[strategy.id] = 0;
  for (const scope of STORAGE_SCOPES) {
    // 同一个用途里可能出现同一套策略（正常 UI 会阻止），只按用途计数一次。
    for (const id of new Set(scopeStrategyIds(settings, scope))) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * 生成 `.env` 片段时的「全局策略」：被最多用途使用的那一套。
 *
 * 数量并列时取 `strategies` 数组里靠前的一套；一套都没被引用时取第一套。
 */
export function globalStrategyOf(settings: StorageSettings): StorageStrategy {
  const strategies = settings.strategies.length
    ? settings.strategies
    : defaultStorage().strategies;
  const counts = scopeUsageCounts({
    ...settings,
    strategies,
  });
  let best = strategies[0];
  let bestCount = counts[best.id] ?? 0;
  for (const strategy of strategies.slice(1)) {
    const count = counts[strategy.id] ?? 0;
    if (count > bestCount) {
      best = strategy;
      bestCount = count;
    }
  }
  return best;
}

/** 实际被用途引用到的策略（按用途与分配顺序去重）。 */
export function usedStrategies(settings: StorageSettings): StorageStrategy[] {
  const seen = new Set<string>();
  const out: StorageStrategy[] = [];
  for (const scope of STORAGE_SCOPES) {
    for (const id of scopeStrategyIds(settings, scope)) {
      const strategy = findStrategy(settings, id);
      if (seen.has(strategy.id)) continue;
      seen.add(strategy.id);
      out.push(strategy);
    }
  }
  return out;
}

/** 旧结构里的单个用途覆盖（driver 可能是 inherit）。 */
interface LegacyScopeSettings {
  driver: 'inherit' | StorageDriver;
  local_dir: string;
  s3_bucket: string;
  s3_prefix: string;
}

function readLegacyScope(raw: unknown): LegacyScopeSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const driver =
    source.driver === 'local' || source.driver === 's3' ? source.driver : 'inherit';
  return {
    driver,
    local_dir: withoutTrailingSlash(text(source.local_dir, '', 300)),
    s3_bucket: withoutEdgeSlashes(text(source.s3_bucket, '', 120)),
    s3_prefix: withoutEdgeSlashes(text(source.s3_prefix, '', 200)),
  };
}

/**
 * 把旧结构（全局 driver + 分用途覆盖）迁移成策略列表。
 *
 * - 旧的全局设置成为第一套策略：本地 → id `local`、名称「本地储存」；
 *   云 → id `cloud`、名称「云对象存储」。
 * - 每个 `inherit` 之外的用途各自成为一套策略（id `scope-<用途>`），并让该用途
 *   指向它；`inherit` 的用途指向第一套。
 * - 旧的用途覆盖沿用全局的 endpoint / 区域 / Access Key，这里复制一份方便编辑；
 *   真正生成的片段仍只写桶与前缀（服务器只有一套云凭据）。
 */
function migrateLegacy(source: Record<string, unknown>): StorageSettings {
  const driver = readDriver(source.driver);
  const globalStrategy: StorageStrategy = normalizeStrategy(
    {
      driver,
      name: storageDriverLabel(driver),
      local_dir: text(source.local_dir, DEFAULT_LOCAL_DIR, 300),
      s3_bucket: text(source.s3_bucket, '', 120),
      s3_prefix: text(source.s3_prefix, '', 200),
      s3_endpoint: text(source.s3_endpoint, '', 300),
      s3_region: text(source.s3_region, DEFAULT_S3_REGION, 80),
      s3_access_key: text(source.s3_access_key, '', 200),
      s3_public_base_url: text(source.s3_public_base_url, '', 300),
    },
    driver === 's3' ? 'cloud' : DEFAULT_STRATEGY_ID,
  );

  const strategies: StorageStrategy[] = [globalStrategy];
  const scopes = {} as Record<StorageScope, string>;
  const rawScopes = (source.scopes && typeof source.scopes === 'object'
    ? source.scopes
    : {}) as Record<string, unknown>;

  for (const scope of STORAGE_SCOPES) {
    const legacy = readLegacyScope(rawScopes[scope]);
    if (legacy.driver === 'inherit') {
      scopes[scope] = globalStrategy.id;
      continue;
    }
    const strategy = normalizeStrategy(
      {
        name: t('{scope}专用', { scope: scopeLabel(scope) }),
        driver: legacy.driver,
        local_dir: legacy.local_dir,
        s3_bucket: legacy.s3_bucket,
        s3_prefix: legacy.s3_prefix,
        s3_endpoint: globalStrategy.s3_endpoint,
        s3_region: globalStrategy.s3_region,
        s3_access_key: globalStrategy.s3_access_key,
        s3_public_base_url: globalStrategy.s3_public_base_url,
      },
      `scope-${scope}`,
    );
    strategies.push(strategy);
    scopes[scope] = strategy.id;
  }

  const settled = settleStrategies(strategies);
  const scopeIds = fallbackScopeIds(scopes, settled);
  const allocations = buildAllocations(undefined, settled, scopeIds);
  return {
    strategies: settled,
    scopes: scopeIdsFromAllocations(allocations),
    allocations,
    max_upload_mb: 25,
    max_content_chars: MAX_CONTENT_SOURCE_CHARS,
  };
}

/** 用途 id 指向已被截断/淘汰的策略时，回落到第一套。 */
function fallbackScopeIds(
  raw: Record<StorageScope, string>,
  strategies: StorageStrategy[],
): Record<StorageScope, string> {
  const first = strategies[0].id;
  const ids = new Set(strategies.map((strategy) => strategy.id));
  const scopes = {} as Record<StorageScope, string>;
  for (const scope of STORAGE_SCOPES) {
    const id = typeof raw[scope] === 'string' ? raw[scope].trim() : '';
    scopes[scope] = ids.has(id) ? id : first;
  }
  return scopes;
}

/**
 * 组装四个用途的完整分配。
 *
 * `source.allocations` 存在且合法时保留多策略与容量上限；否则按传入的
 * `scopes`（旧配置的主策略）回退成单策略。这样旧配置升级后不会丢掉用途指向。
 */
function buildAllocations(
  source: Record<string, unknown> | undefined,
  strategies: StorageStrategy[],
  scopes: Record<StorageScope, string>,
): Record<StorageScope, StorageScopeAllocation> {
  const allocations = {} as Record<StorageScope, StorageScopeAllocation>;
  for (const scope of STORAGE_SCOPES) {
    allocations[scope] = readAllocation(source, scope, scopes[scope], strategies);
  }
  return allocations;
}

/**
 * 把任意来源（旧配置、导入 JSON、手写对象）收敛成合法的储存设置。
 *
 * 同时接受两种形状：
 * - 新结构：`{ strategies, scopes, allocations?, max_upload_mb }`；
 * - 旧结构：`{ driver, local_dir, s3_*, scopes[scope].driver }`，逐项迁移。
 *
 * `allocations` 里的多策略顺序与容量上限会被保留；缺少该字段时按 `scopes`
 * 回退成单策略。空值、坏数组、没有一套可用策略时整体回退到 `defaultStorage()`。
 */
export function normalizeStorage(raw: Partial<StorageSettings> | undefined): StorageSettings {
  const fallback = defaultStorage();
  const source = (raw && typeof raw === 'object' ? raw : undefined) as
    | Record<string, unknown>
    | undefined;
  if (!source) return fallback;

  const max_upload_mb = settingInt(source.max_upload_mb, fallback.max_upload_mb, 1, 2048);
  const max_content_chars = settingInt(
    source.max_content_chars,
    fallback.max_content_chars,
    1,
    MAX_CONTENT_SOURCE_CHARS,
  );

  if (Array.isArray(source.strategies)) {
    const strategies: StorageStrategy[] = [];
    for (const item of source.strategies) {
      if (strategies.length >= MAX_STRATEGIES) break;
      if (!item || typeof item !== 'object') continue;
      const entry = item as Partial<StorageStrategy>;
      strategies.push(normalizeStrategy(entry, sanitizeId(entry.id, strategies.length)));
    }
    const settled = settleStrategies(strategies);
    if (!settled.length) return { ...fallback, max_upload_mb, max_content_chars };
    const scopes = fallbackScopeIds(
      (source.scopes && typeof source.scopes === 'object'
        ? source.scopes
        : {}) as Record<StorageScope, string>,
      settled,
    );
    const allocations = buildAllocations(source, settled, scopes);
    return {
      strategies: settled,
      scopes: scopeIdsFromAllocations(allocations),
      allocations,
      max_upload_mb,
      max_content_chars,
    };
  }

  // 没有 strategies 数组：一律按旧结构迁移（空对象迁移结果就等于默认值）。
  const migrated = migrateLegacy(source);
  return { ...migrated, max_upload_mb, max_content_chars };
}

export function readStorage(config: Pick<WebConfig, 'storage'>): StorageSettings {
  return normalizeStorage(config.storage);
}

/**
 * 保存前的地址校验；返回空串表示通过。
 *
 * endpoint 与公开访问地址都必须是带 http(s) 协议的绝对地址：AWS SDK 需要
 * scheme，而 `cdn.example.com` 这种写法在片段里只会变成一个坏值。
 */
export function storageUrlError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return t('需要以 http:// 或 https:// 开头。');
  }
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return t('缺少主机名。');
    return '';
  } catch {
    return t('不是有效的地址。');
  }
}

function envValue(value: string): string {
  return value.trim();
}

function secretLines(secret: string): string[] {
  const trimmed = envValue(secret);
  if (trimmed) {
    return [
      t('# 下面这行包含刚输入的密钥：只粘贴到服务器的 .env，不要提交到 Git'),
      `STORAGE_S3_SECRET_KEY=${trimmed}`,
    ];
  }
  return [
    t('# STORAGE_S3_SECRET_KEY=（未填写：密钥只存在于服务器；可改用实例角色或部署时注入）'),
  ];
}

/** 全局策略对应的 `STORAGE_*` 变量。 */
function globalEnvLines(strategy: StorageStrategy, secret: string): string[] {
  const lines: string[] = [];

  if (strategy.driver !== 's3') {
    const localDir = envValue(strategy.local_dir) || DEFAULT_LOCAL_DIR;
    lines.push('STORAGE_DRIVER=local');
    lines.push(`STORAGE_DIR=${localDir}`);
    lines.push('');
    lines.push(t('# 目录相对于 API 进程的工作目录；备份或迁移只需拷贝这个目录'));
    lines.push(t('# 多实例部署不要指向共享网络盘（SQLite 锁与文件锁都不可靠）'));
    return lines;
  }

  lines.push('STORAGE_DRIVER=s3');
  lines.push(
    `STORAGE_S3_BUCKET=${envValue(strategy.s3_bucket) || t('<必填：桶名，例如 practacu-press>')}`,
  );
  lines.push(`STORAGE_S3_REGION=${envValue(strategy.s3_region) || DEFAULT_S3_REGION}`);

  if (strategy.s3_endpoint.trim()) {
    lines.push(`STORAGE_S3_ENDPOINT=${envValue(strategy.s3_endpoint)}`);
  } else {
    lines.push(t('# STORAGE_S3_ENDPOINT=（留空表示 AWS S3；MinIO / OSS / COS 填兼容地址）'));
  }

  if (strategy.s3_access_key.trim()) {
    lines.push(`STORAGE_S3_ACCESS_KEY=${envValue(strategy.s3_access_key)}`);
  } else {
    lines.push(t('# STORAGE_S3_ACCESS_KEY=（未填写：可使用实例角色或部署环境里的凭据）'));
  }

  lines.push(...secretLines(secret));

  if (strategy.s3_prefix.trim()) {
    lines.push(`STORAGE_S3_PREFIX=${envValue(strategy.s3_prefix)}`);
  } else {
    lines.push(t('# STORAGE_S3_PREFIX=（可选：同一桶放多个站点时填前缀，留空写桶根）'));
  }
  return lines;
}

/** 单个用途覆盖的环境变量：只写驱动与位置，云凭据永远来自全局。 */
function scopeEnvLines(scope: StorageScope, strategy: StorageStrategy): string[] {
  const prefix = `STORAGE_${scope.toUpperCase()}`;
  const lines = [
    t('# {scope} → 策略「{name}」（{driver}）', {
      scope: scope.toUpperCase(),
      name: strategy.name,
      driver: storageDriverLabel(strategy.driver),
    }),
  ];

  if (strategy.driver === 'local') {
    const localDir = envValue(strategy.local_dir);
    lines.push(`${prefix}_DRIVER=local`);
    if (localDir) {
      lines.push(`${prefix}_LOCAL_DIR=${localDir}`);
    } else {
      lines.push(t('# 目录留空时由服务器使用默认本地目录（通常是全局目录下的用途子目录）'));
      lines.push(`${prefix}_LOCAL_DIR=`);
    }
    return lines;
  }

  lines.push(`${prefix}_DRIVER=s3`);
  lines.push(`${prefix}_S3_BUCKET=${envValue(strategy.s3_bucket) || t('<必填：桶名>')}`);
  if (envValue(strategy.s3_prefix)) {
    lines.push(`${prefix}_S3_PREFIX=${envValue(strategy.s3_prefix)}`);
  } else {
    lines.push(t('# {prefix}_S3_PREFIX=（可选：留空写在桶根）', { prefix }));
  }
  return lines;
}

/**
 * 生成 API 的 `.env` 片段。
 *
 * - 全局段来自「被最多用途使用的策略」（并列取数组靠前的一套）；
 * - 其余每个用途如果指向别的策略，就写自己的
 *   `STORAGE_<SCOPE>_DRIVER` / `_LOCAL_DIR` / `_S3_BUCKET` / `_S3_PREFIX`；
 * - 指向全局策略的用途不写变量，只留注释；
 * - `s3_public_base_url` 只是记录用的提示，后端没有对应变量，所以不会出现在
 *   片段里；Secret Key 只来自页面输入框，也不会写进浏览器配置。
 */
export function buildStorageEnvSnippet(
  settings: StorageSettings,
  secret = '',
): string {
  const normalized = normalizeStorage(settings);
  const globalStrategy = globalStrategyOf(normalized);
  const lines: string[] = [
    t('# 由 Practacu Press「站点设置 → 储存策略」生成'),
    t('# 复制到 API 的 .env 后重启服务才生效；本页不会修改服务器'),
    `MAX_CONTENT_SOURCE_CHARS=${normalized.max_content_chars}`,
    '',
    t('# 全局段：被最多用途使用的策略「{name}」（{driver}）', {
      name: globalStrategy.name,
      driver: storageDriverLabel(globalStrategy.driver),
    }),
    ...globalEnvLines(globalStrategy, secret),
    '',
    t('# --- 用途覆盖（文章媒体 / 站点图片 / 用户头像 / 用户数据与附件） ---'),
  ];

  const overrides = STORAGE_SCOPES.filter(
    (scope) => normalized.scopes[scope] !== globalStrategy.id,
  );

  if (!overrides.length) {
    lines.push(
      t('# 四个用途都使用同一套「{name}」：没有生成 STORAGE_<SCOPE>_* 变量', {
        name: globalStrategy.name,
      }),
    );
  } else {
    for (const scope of overrides) {
      lines.push('');
      lines.push(...scopeEnvLines(scope, findStrategy(normalized, normalized.scopes[scope])));
    }
    const inherited = STORAGE_SCOPES.filter((scope) => !overrides.includes(scope));
    if (inherited.length) {
      lines.push('');
      lines.push(
        t('# 沿用全局策略「{name}」的用途：{scopes}', {
          name: globalStrategy.name,
          scopes: inherited.map((scope) => scope.toUpperCase()).join(' / '),
        }),
      );
    }
    lines.push('');
    lines.push(
      t('# 非全局的云策略只写桶与前缀：endpoint、区域与 Access Key 都取自全局策略'),
    );
  }

  const used = usedStrategies(normalized);
  const cloudStrategies = used.filter((strategy) => strategy.driver === 's3');
  if (globalStrategy.driver !== 's3' && cloudStrategies.length) {
    lines.push(
      t('# 注意：当前全局策略是本地储存，片段里没有 STORAGE_S3_* 凭据；指向云策略的用途需要服务器另行提供 endpoint / 区域 / 凭据'),
    );
  }
  if (cloudStrategies.length > 1) {
    lines.push(
      t('# 服务器目前只支持一套云凭据：多套云策略共用同一个 endpoint、区域与 Access Key'),
    );
  }

  lines.push('');
  lines.push(t('# 已有文件不会自动迁移：旧目录 / 旧桶里的对象需要自己同步'));
  lines.push(t('# 公开读权限、CDN 与防盗链由桶策略决定，API 与服务端环境变量都不负责'));
  for (const strategy of normalized.strategies) {
    if (strategy.s3_public_base_url.trim()) {
      lines.push(
        t('# 记录用的公开访问地址（API 不读取）：{name} → {url}', {
          name: strategy.name,
          url: envValue(strategy.s3_public_base_url),
        }),
      );
    }
  }
  return lines.join('\n');
}

/* ------------------------- 运行期应用（GET / PUT /system/storage） ------------------------- */

/** 归一化后的四个用途分配；旧对象缺字段时回落到默认值。 */
function normalizedAllocations(
  settings: StorageSettings,
): Record<StorageScope, StorageScopeAllocation> {
  return settings.allocations ?? defaultStorage().allocations!;
}

/** 单个用途的分配：只保留服务端认识的字段，顺序就是写入顺序。 */
function allocationPayload(allocation: StorageScopeAllocation): StorageScopeAllocation {
  return {
    mode: allocation.mode,
    entries: allocation.entries.map((entry) => ({
      strategy_id: entry.strategy_id,
      quota_gb: entry.quota_gb,
    })),
    overflow: allocation.overflow,
  };
}

/**
 * 把本页设置翻译成 `PUT /api/v1/system/storage` 的请求体。
 *
 * - `strategies` 保持配置顺序，只提交服务端认识的字段；`secretDrafts` 里
 *   **去空白后非空**的草稿才会变成 `s3_secret_key`——密钥只随这一次请求提交，
 *   不写进浏览器配置，也不会回显；
 * - `scopes` 取每个用途分配顺序的第一套（服务端主策略）；
 * - `allocations` 四个用途全带上：`mode`、有序 `entries`（`strategy_id` +
 *   `quota_gb`）与 `overflow` 由服务端在写入时执行，配额不再只是页面的计划；
 * - `max_upload_mb` 与 `s3_public_base_url` 只是页面提示，不提交。
 */
export function storageApplyPayload(
  settings: StorageSettings,
  secretDrafts: Record<string, string> = {},
): StorageApplyRequest {
  const normalized = normalizeStorage(settings);
  const allocations = normalizedAllocations(normalized);
  const scopes: Record<string, string> = {};
  for (const scope of STORAGE_SCOPES) {
    scopes[scope] =
      allocations[scope].entries[0]?.strategy_id ?? normalized.scopes[scope];
  }
  return {
    global_strategy_id: globalStrategyOf(normalized).id,
    strategies: normalized.strategies.map((strategy) => {
      const out: StorageApplyStrategy = {
        id: strategy.id,
        name: strategy.name,
        driver: strategy.driver,
        local_dir: strategy.local_dir,
        s3_bucket: strategy.s3_bucket,
        s3_prefix: strategy.s3_prefix,
        s3_endpoint: strategy.s3_endpoint,
        s3_region: strategy.s3_region,
        s3_access_key: strategy.s3_access_key,
      };
      const secret = (secretDrafts[strategy.id] ?? '').trim();
      if (secret) out.s3_secret_key = secret;
      return out;
    }),
    scopes,
    allocations: {
      content: allocationPayload(allocations.content),
      site: allocationPayload(allocations.site),
      avatar: allocationPayload(allocations.avatar),
      attachment: allocationPayload(allocations.attachment),
    },
    max_content_chars: normalized.max_content_chars,
  };
}

/**
 * 「部署签名」：只包含真正影响「上传写到哪里、写满怎么办」的字段。
 *
 * 用于判断一次保存之后是否需要重新应用：与上次应用成功时的签名相同就跳过。
 * 顺序固定（策略按配置顺序、用途按 `STORAGE_SCOPES`、条目按写入顺序），内容
 * 相同的设置永远得到相同的签名。**不含任何密钥**：Secret Key 只存在于组件状态；
 * Access Key 的值会进签名（它不是密钥，本来就保存在本地配置里）。改名、改目录、
 * 改桶、改 endpoint / 区域、改用途指向、改配额 / 模式 / 顺序 / overflow 都会让
 * 签名变化；`max_content_chars` 会进签名，因为它影响服务端校验。`max_upload_mb`
 * 与 `s3_public_base_url` 只是页面提示，不进签名。
 */
export function storageApplySignature(settings: StorageSettings): string {
  const normalized = normalizeStorage(settings);
  const allocations = normalizedAllocations(normalized);
  return JSON.stringify({
    global_strategy_id: globalStrategyOf(normalized).id,
    strategies: normalized.strategies.map((strategy) => [
      strategy.id,
      strategy.name,
      strategy.driver,
      strategy.local_dir,
      strategy.s3_bucket,
      strategy.s3_prefix,
      strategy.s3_endpoint,
      strategy.s3_region,
      strategy.s3_access_key,
    ]),
    scopes: STORAGE_SCOPES.map((scope) => [scope, normalized.scopes[scope]]),
    allocations: STORAGE_SCOPES.map((scope) => [
      scope,
      allocations[scope].mode,
      allocations[scope].entries.map((entry) => [entry.strategy_id, entry.quota_gb]),
      allocations[scope].overflow,
    ]),
    max_content_chars: normalized.max_content_chars,
  });
}

/**
 * 把服务端运行期状态还原成页面可编辑的设置。
 *
 * 服务端只回传「有没有保存凭据」，不回传 Access Key / Secret；因此同名策略
 * 的 Access Key 与公开访问地址从本机配置里沿用，其余字段（目录、桶、前缀、
 * endpoint、区域、分配与配额）以服务端为准。这样在另一台电脑打开页面时，
 * 看到的是真正在跑的设置，而不是本机缓存的默认值。
 */
export function storageSettingsFromStatus(
  status: StorageStatus,
  local: StorageSettings,
): StorageSettings {
  if (!status.strategies.length) return normalizeStorage(local);

  const localById = new Map(local.strategies.map((strategy) => [strategy.id, strategy]));
  const strategies: StorageStrategy[] = status.strategies.map((strategy) => {
    const cached = localById.get(strategy.id);
    return {
      id: strategy.id,
      name: strategy.name || cached?.name || strategy.id,
      driver: strategy.driver,
      local_dir: strategy.local_dir,
      s3_bucket: strategy.s3_bucket,
      s3_prefix: strategy.s3_prefix,
      s3_endpoint: strategy.s3_endpoint,
      s3_region: strategy.s3_region,
      s3_access_key: cached?.s3_access_key ?? '',
      s3_public_base_url: cached?.s3_public_base_url ?? '',
    };
  });

  const allocations = {} as Record<StorageScope, StorageScopeAllocation>;
  const scopes = {} as Record<StorageScope, string>;
  for (const scope of STORAGE_SCOPES) {
    const runtime = status.allocations?.[scope];
    const primary = status.scopes[scope] || strategies[0].id;
    const entries: StorageAllocationEntry[] =
      runtime && runtime.entries.length
        ? runtime.entries.map((entry) => ({
            strategy_id: entry.strategy_id,
            quota_gb: entry.quota_gb,
          }))
        : [{ strategy_id: primary, quota_gb: 0 }];
    allocations[scope] = {
      mode: runtime?.mode === 'quota' ? 'quota' : 'single',
      entries,
      overflow: runtime?.overflow === 'stop' ? 'stop' : 'switch',
    };
    scopes[scope] = entries[0].strategy_id;
  }

  return normalizeStorage({
    strategies,
    scopes,
    allocations,
    max_upload_mb: local.max_upload_mb,
    max_content_chars: status.max_content_chars ?? local.max_content_chars,
  });
}
