import type {
  StorageDriver,
  StorageScope,
  StorageScopeSettings,
  StorageSettings,
  WebConfig,
} from '../types';
import { settingInt, settingText } from './settings';

/**
 * 媒体存储策略。
 *
 * 与「性能优化」「访问限制」同一套模式：浏览器只保存选择，并把选择翻译成
 * 可直接粘贴的 API `.env` 片段。真正的存储由 API 启动时读取的 `STORAGE_*`
 * 环境变量决定，所以切换后必须重启；已上传的文件不会自动搬运。
 *
 * 全局设置之外，文章媒体 / 站点图片 / 用户头像 / 用户数据可以单独覆盖；
 * 没有覆盖的用途沿用全局。分用途的 S3 覆盖只换桶与前缀，endpoint、区域和
 * 凭据仍来自全局 `STORAGE_S3_*`。
 *
 * 默认值与 `apps/api/internal/platform/config/config.go` 及根目录
 * `.env.example` 保持一致：`STORAGE_DRIVER=local`、`STORAGE_DIR=./data/media`，
 * S3 模式下桶必填，endpoint / prefix 可空（空 endpoint 表示 AWS）。
 */

/** 有独立存储设置的用途，顺序也用于生成片段与页面卡片。 */
export const STORAGE_SCOPES: readonly StorageScope[] = [
  'content',
  'site',
  'avatar',
  'attachment',
];

function inheritScope(): StorageScopeSettings {
  return { driver: 'inherit', local_dir: '', s3_bucket: '', s3_prefix: '' };
}

export const DEFAULT_STORAGE: StorageSettings = {
  driver: 'local',
  local_dir: './data/media',
  // 空 endpoint 表示 AWS；MinIO / OSS / COS 填 S3 兼容地址。
  s3_endpoint: '',
  // 与 .env.example 的示例值一致；SDK 在留空时也按 us-east-1 处理。
  s3_region: 'us-east-1',
  s3_bucket: '',
  s3_prefix: '',
  s3_public_base_url: '',
  s3_access_key: '',
  // 与 API 的 25 MiB 附件上限一致；这个值只用于页面提示。
  max_upload_mb: 25,
  scopes: {
    content: inheritScope(),
    site: inheritScope(),
    avatar: inheritScope(),
    attachment: inheritScope(),
  },
};

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

function readScopeDriver(value: unknown): StorageScopeSettings['driver'] {
  return value === 'local' || value === 's3' ? value : 'inherit';
}

/** 把单个用途覆盖收敛成合法形状；未知 driver 一律当「沿用全局」。 */
export function normalizeScopeSettings(
  raw: Partial<StorageScopeSettings> | undefined,
): StorageScopeSettings {
  return {
    driver: readScopeDriver(raw?.driver),
    local_dir: withoutTrailingSlash(text(raw?.local_dir, '', 300)),
    s3_bucket: withoutEdgeSlashes(text(raw?.s3_bucket, '', 120)),
    s3_prefix: withoutEdgeSlashes(text(raw?.s3_prefix, '', 200)),
  };
}

function readScopes(raw: unknown): Record<StorageScope, StorageScopeSettings> {
  const source =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const scopes = {} as Record<StorageScope, StorageScopeSettings>;
  for (const scope of STORAGE_SCOPES) {
    const value = source[scope];
    scopes[scope] = normalizeScopeSettings(
      value && typeof value === 'object'
        ? (value as Partial<StorageScopeSettings>)
        : undefined,
    );
  }
  return scopes;
}

/** 把任意来源（旧配置、导入 JSON、手写对象）收敛成合法的存储策略。 */
export function normalizeStorage(raw: Partial<StorageSettings> | undefined): StorageSettings {
  const localDir = withoutTrailingSlash(
    text(raw?.local_dir, DEFAULT_STORAGE.local_dir, 300),
  );
  return {
    driver: readDriver(raw?.driver),
    local_dir: localDir || DEFAULT_STORAGE.local_dir,
    s3_endpoint: withoutTrailingSlash(text(raw?.s3_endpoint, '', 300)),
    s3_region: text(raw?.s3_region, DEFAULT_STORAGE.s3_region, 80),
    s3_bucket: withoutEdgeSlashes(text(raw?.s3_bucket, '', 120)),
    // 对象键前缀两侧的斜杠由后端自己处理，这里提前收紧成不含斜杠的写法。
    s3_prefix: withoutEdgeSlashes(text(raw?.s3_prefix, '', 200)),
    s3_public_base_url: withoutTrailingSlash(text(raw?.s3_public_base_url, '', 300)),
    s3_access_key: text(raw?.s3_access_key, '', 200),
    max_upload_mb: settingInt(
      raw?.max_upload_mb,
      DEFAULT_STORAGE.max_upload_mb,
      1,
      2048,
    ),
    // 旧配置没有 scopes，四个用途全部回到「沿用全局」。
    scopes: readScopes(raw?.scopes),
  };
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
    return '需要以 http:// 或 https:// 开头。';
  }
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return '缺少主机名。';
    return '';
  } catch {
    return '不是有效的地址。';
  }
}

function envValue(value: string): string {
  return value.trim();
}

function secretLines(secret: string): string[] {
  const trimmed = envValue(secret);
  if (trimmed) {
    return [
      '# 下面这行包含刚输入的密钥：只粘贴到服务器的 .env，不要提交到 Git',
      `STORAGE_S3_SECRET_KEY=${trimmed}`,
    ];
  }
  return [
    '# STORAGE_S3_SECRET_KEY=（未填写：密钥只存在于服务器；可改用实例角色或部署时注入）',
  ];
}

function globalEnvLines(settings: StorageSettings, secret: string): string[] {
  const lines: string[] = [];

  if (settings.driver !== 's3') {
    const localDir = envValue(settings.local_dir) || DEFAULT_STORAGE.local_dir;
    lines.push('STORAGE_DRIVER=local');
    lines.push(`STORAGE_DIR=${localDir}`);
    lines.push('');
    lines.push('# 目录相对于 API 进程的工作目录；备份或迁移只需拷贝这个目录');
    lines.push('# 多实例部署不要指向共享网络盘（SQLite 锁与文件锁都不可靠）');
    return lines;
  }

  lines.push('STORAGE_DRIVER=s3');
  lines.push(
    `STORAGE_S3_BUCKET=${envValue(settings.s3_bucket) || '<必填：桶名，例如 practacu-press>'}`,
  );
  lines.push(`STORAGE_S3_REGION=${envValue(settings.s3_region) || 'us-east-1'}`);

  if (settings.s3_endpoint.trim()) {
    lines.push(`STORAGE_S3_ENDPOINT=${envValue(settings.s3_endpoint)}`);
  } else {
    lines.push('# STORAGE_S3_ENDPOINT=（留空表示 AWS S3；MinIO / OSS / COS 填兼容地址）');
  }

  if (settings.s3_access_key.trim()) {
    lines.push(`STORAGE_S3_ACCESS_KEY=${envValue(settings.s3_access_key)}`);
  } else {
    lines.push('# STORAGE_S3_ACCESS_KEY=（未填写：可使用实例角色或部署环境里的凭据）');
  }

  lines.push(...secretLines(secret));

  if (settings.s3_prefix.trim()) {
    lines.push(`STORAGE_S3_PREFIX=${envValue(settings.s3_prefix)}`);
  } else {
    lines.push('# STORAGE_S3_PREFIX=（可选：同一桶放多个站点时填前缀，留空写桶根）');
  }
  return lines;
}

/** 单个用途覆盖的环境变量；inherit 不写变量。 */
function scopeEnvLines(scope: StorageScope, value: StorageScopeSettings): string[] {
  const prefix = `STORAGE_${scope.toUpperCase()}`;
  if (value.driver === 'local') {
    const localDir = envValue(value.local_dir);
    return localDir
      ? [`${prefix}_DRIVER=local`, `${prefix}_LOCAL_DIR=${localDir}`]
      : [
          `${prefix}_DRIVER=local`,
          '# 目录留空时由服务器使用默认本地目录（通常 ./data/media）',
          `${prefix}_LOCAL_DIR=`,
        ];
  }
  if (value.driver !== 's3') return [];

  const lines = [
    `${prefix}_DRIVER=s3`,
    `${prefix}_S3_BUCKET=${envValue(value.s3_bucket) || '<必填：桶名>'}`,
  ];
  if (envValue(value.s3_prefix)) {
    lines.push(`${prefix}_S3_PREFIX=${envValue(value.s3_prefix)}`);
  } else {
    lines.push(`# ${prefix}_S3_PREFIX=（可选：留空写在桶根）`);
  }
  return lines;
}

/**
 * 生成 API 的 `.env` 片段。
 *
 * 全局部分保持原有变量；随后只给「不是 inherit」的用途写
 * `STORAGE_<SCOPE>_DRIVER` / `_LOCAL_DIR` / `_S3_BUCKET` / `_S3_PREFIX`。
 * inherit 的用途不写任何变量，只留注释说明沿用全局。`s3_public_base_url`
 * 只是记录用的提示，后端没有对应变量，所以不会出现在片段里。
 */
export function buildStorageEnvSnippet(
  settings: StorageSettings,
  secret = '',
): string {
  const lines = [
    '# 由 Practacu Press「站点设置 → 存储策略」生成',
    '# 复制到 API 的 .env 后重启服务才生效；本页不会修改服务器',
    '',
    ...globalEnvLines(settings, secret),
    '',
    '# --- 分用途存储（文章媒体 / 站点图片 / 用户头像 / 用户数据与附件） ---',
  ];

  const scopes = settings.scopes;
  const overrides = STORAGE_SCOPES.filter((scope) => {
    const driver = scopes?.[scope]?.driver;
    return driver === 'local' || driver === 's3';
  });

  if (!overrides.length) {
    lines.push('# 四个用途都沿用全局：没有生成 STORAGE_<SCOPE>_* 变量');
  } else {
    for (const scope of overrides) {
      lines.push('');
      lines.push(...scopeEnvLines(scope, scopes[scope]));
    }
    const inherited = STORAGE_SCOPES.filter((scope) => !overrides.includes(scope));
    if (inherited.length) {
      lines.push('');
      lines.push(
        `# 沿用全局的用途：${inherited.map((scope) => scope.toUpperCase()).join(' / ')}`,
      );
    }
    lines.push('');
    lines.push('# 分用途的 S3 覆盖沿用全局的 endpoint、区域与凭据，只需要桶与前缀');
    if (settings.driver !== 's3') {
      lines.push(
        '# 注意：当前全局是本地存储，上面没有 STORAGE_S3_* 凭据；分用途 S3 覆盖需要服务器另行提供 endpoint / 凭据',
      );
    }
  }

  lines.push('');
  lines.push('# 已有文件不会自动迁移：旧目录 / 旧桶里的对象需要自己同步');
  lines.push('# 公开读权限、CDN 与防盗链由桶策略决定，API 与服务端环境变量都不负责');
  if (settings.s3_public_base_url.trim()) {
    lines.push(`# 记录用的公开访问前缀（API 不读取）：${envValue(settings.s3_public_base_url)}`);
  }
  return lines.join('\n');
}
