import { describe, expect, it } from 'vitest';
import type { StorageSettings, StorageStrategy } from '../types';
import {
  DEFAULT_LOCAL_DIR,
  MAX_STRATEGIES,
  STORAGE_SCOPES,
  buildStorageEnvSnippet,
  createStrategyId,
  defaultStorage,
  emptyStrategy,
  findStrategy,
  globalStrategyOf,
  normalizeStorage,
  normalizeStrategy,
  readStorage,
  scopeAllocation,
  scopeStrategyIds,
  scopesUsingStrategy,
  storageUrlError,
  strategyLocation,
} from './storage';

/** 一套本地策略的最小形状，测试里按需改字段。 */
function localStrategy(
  id: string,
  name: string,
  localDir = DEFAULT_LOCAL_DIR,
): StorageStrategy {
  return {
    ...emptyStrategy(),
    id,
    name,
    driver: 'local',
    local_dir: localDir,
  };
}

function cloudStrategy(id: string, name: string, bucket: string): StorageStrategy {
  return {
    ...emptyStrategy(),
    id,
    name,
    driver: 's3',
    local_dir: '',
    s3_bucket: bucket,
  };
}

/** 四个用途都指向同一套策略的设置。 */
function allScopes(settings: StorageSettings, id: string): StorageSettings {
  return {
    ...settings,
    scopes: {
      content: id,
      site: id,
      avatar: id,
      attachment: id,
    },
  };
}

describe('readStorage / defaultStorage', () => {
  it('returns the tiny local default for a missing config', () => {
    expect(readStorage({})).toEqual(defaultStorage());
    expect(readStorage({ storage: undefined })).toEqual(defaultStorage());
    expect(normalizeStorage(undefined)).toEqual(defaultStorage());
  });

  it('defaults to a single local strategy used by every scope', () => {
    const storage = defaultStorage();
    expect(storage.strategies).toHaveLength(1);
    expect(storage.strategies[0].id).toBe('local');
    expect(storage.strategies[0].name).toBe('本地储存');
    expect(storage.strategies[0].driver).toBe('local');
    expect(storage.strategies[0].local_dir).toBe('./data/media');
    expect(storage.media_user_quota_bytes).toBe(512 * 1024 * 1024);
expect(storage.media_user_article_bytes).toBe(0);
expect(storage.media_user_upload_bytes).toBe(0);
    expect(STORAGE_SCOPES).toEqual(['content', 'site', 'avatar', 'attachment']);
    for (const scope of STORAGE_SCOPES) {
      expect(storage.scopes[scope]).toBe('local');
    }
  });
});

describe('normalizeStorage for the strategy model', () => {
  it('trims values, strips edge slashes and clamps the upload hint', () => {
    const storage = normalizeStorage({
      strategies: [
        {
          id: 'Local',
          name: '  本地储存  ',
          driver: 'local',
          local_dir: '  /srv/press/media/  ',
        },
        {
          id: 'cos',
          name: ' 图床 COS ',
          driver: 's3',
          s3_endpoint: 'https://cos.example.com/',
          s3_region: ' ap-shanghai ',
          s3_bucket: '  practacu-press ',
          s3_prefix: '/sites/main/',
          s3_public_base_url: 'https://cdn.example.com/media/',
          s3_access_key: ' AKIDEXAMPLE ',
        },
      ],
      scopes: { content: 'cos', site: 'cos', avatar: 'cos', attachment: 'cos' },
      media_user_quota_bytes: 0,
      media_user_article_bytes: 0,
      media_user_upload_bytes: 0,
    } as never);

    expect(storage.media_user_quota_bytes).toBe(0);
    expect(storage.strategies).toHaveLength(2);
    const [local, cloud] = storage.strategies;
    expect(local.id).toBe('local');
    expect(local.name).toBe('本地储存');
    expect(local.local_dir).toBe('/srv/press/media');
    expect(cloud.id).toBe('cos');
    expect(cloud.name).toBe('图床 COS');
    expect(cloud.driver).toBe('s3');
    expect(cloud.s3_endpoint).toBe('https://cos.example.com');
    expect(cloud.s3_region).toBe('ap-shanghai');
    expect(cloud.s3_bucket).toBe('practacu-press');
    expect(cloud.s3_prefix).toBe('sites/main');
    expect(cloud.s3_public_base_url).toBe('https://cdn.example.com/media');
    expect(cloud.s3_access_key).toBe('AKIDEXAMPLE');
    expect(storage.scopes.content).toBe('cos');
  });

  it('falls back to the first strategy for missing or unknown scope ids', () => {
    const storage = normalizeStorage({
      strategies: [localStrategy('a', 'A'), cloudStrategy('b', 'B', 'bucket')],
      scopes: { content: 'nope', site: '', avatar: 'b' },
    } as never);
    expect(storage.scopes.content).toBe('a');
    expect(storage.scopes.site).toBe('a');
    expect(storage.scopes.avatar).toBe('b');
    expect(storage.scopes.attachment).toBe('a');
  });

  it('deduplicates ids and names instead of dropping entries', () => {
    const storage = normalizeStorage({
      strategies: [
        localStrategy('same', '同名'),
        cloudStrategy('same', '同名', 'bucket'),
        localStrategy('same', '同名'),
      ],
    } as never);
    expect(storage.strategies.map((strategy) => strategy.id)).toEqual([
      'same',
      'same-2',
      'same-3',
    ]);
    expect(storage.strategies.map((strategy) => strategy.name)).toEqual([
      '同名',
      '同名 2',
      '同名 3',
    ]);
  });

  it('caps the strategy count at the documented maximum', () => {
    const strategies = Array.from({ length: MAX_STRATEGIES + 3 }, (_, index) =>
      localStrategy(`s${index}`, `策略 ${index}`),
    );
    const storage = normalizeStorage({ strategies } as never);
    expect(storage.strategies).toHaveLength(MAX_STRATEGIES);
    // 被截断策略的用途回落到第一套，仍然是非空合法 id。
    for (const scope of STORAGE_SCOPES) {
      expect(storage.strategies.map((strategy) => strategy.id)).toContain(
        storage.scopes[scope],
      );
    }
  });

  it('falls back to the default when the strategy list is empty or broken', () => {
    expect(normalizeStorage({ strategies: [] } as never)).toEqual(defaultStorage());
    expect(normalizeStorage({ strategies: [null, 3, 'x'] } as never)).toEqual(
      defaultStorage(),
    );
    expect(normalizeStorage({} as never)).toEqual(defaultStorage());
  });

  it('is idempotent', () => {
    const once = normalizeStorage({
      strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', 'COS', 'b')],
      scopes: { content: 'cos' },
      media_user_quota_bytes: 40 * 1024 * 1024,
    } as never);
    expect(normalizeStorage(once)).toEqual(once);
  });

  it('keeps the strategy order so ties can resolve to the first one', () => {
    const storage = normalizeStorage({
      strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', 'COS', 'b')],
    } as never);
    expect(storage.strategies[0].id).toBe('local');
    expect(storage.strategies[1].id).toBe('cos');
  });
});

describe('per-scope allocations', () => {
  it('starts each scope as a single unlimited strategy', () => {
    const storage = defaultStorage();
    for (const scope of STORAGE_SCOPES) {
      expect(storage.allocations?.[scope]).toEqual({
        mode: 'single',
        entries: [{ strategy_id: 'local', quota_gb: 0 }],
        overflow: 'switch',
      });
    }
  });

  it('keeps multiple strategies, their order, caps and overflow policy', () => {
    const storage = normalizeStorage({
      strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', '图床', 'bucket')],
      allocations: {
        content: {
          mode: 'quota',
          entries: [
            { strategy_id: 'local', quota_gb: 50 },
            { strategy_id: 'cos', quota_gb: 0 },
          ],
          overflow: 'stop',
        },
        site: {
          mode: 'single',
          entries: [{ strategy_id: 'cos', quota_gb: 0 }],
          overflow: 'switch',
        },
      },
    } as never);

    expect(storage.allocations?.content).toEqual({
      mode: 'quota',
      entries: [
        { strategy_id: 'local', quota_gb: 50 },
        { strategy_id: 'cos', quota_gb: 0 },
      ],
      overflow: 'stop',
    });
    expect(storage.scopes.content).toBe('local');
    expect(scopeStrategyIds(storage, 'content')).toEqual(['local', 'cos']);
    // 单策略模式只使用第一套，即使还保留着多余 entries。
    expect(storage.allocations?.site.entries).toHaveLength(1);
    expect(scopeStrategyIds(storage, 'site')).toEqual(['cos']);
    expect(scopesUsingStrategy(storage, 'cos')).toContain('content');
    expect(scopesUsingStrategy(storage, 'cos')).toContain('site');
    expect(scopeAllocation(storage, 'attachment').mode).toBe('single');
  });

  it('drops unknown and duplicate strategies and clamps caps', () => {
    const storage = normalizeStorage({
      strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', 'COS', 'b')],
      allocations: {
        content: {
          mode: 'quota',
          entries: [
            { strategy_id: 'missing', quota_gb: 10 },
            { strategy_id: 'cos', quota_gb: -4 },
            { strategy_id: 'cos', quota_gb: 12 },
            { strategy_id: 'local', quota_gb: 99999999 },
          ],
          overflow: 'unknown',
        },
      },
    } as never);

    expect(storage.allocations?.content.entries).toEqual([
      { strategy_id: 'cos', quota_gb: 0 },
      { strategy_id: 'local', quota_gb: 1_000_000 },
    ]);
    expect(storage.allocations?.content.overflow).toBe('switch');
    expect(storage.scopes.content).toBe('cos');
    // 其余用途没有分配：按主策略回退成单策略。
    expect(scopeAllocation(storage, 'site').entries).toEqual([
      { strategy_id: 'local', quota_gb: 0 },
    ]);
  });

  it('migrates a legacy scope override into a single allocation', () => {
    const storage = normalizeStorage({
      driver: 'local',
      scopes: {
        content: { driver: 's3', s3_bucket: 'content-bucket' },
      },
    } as never);

    expect(storage.allocations?.content).toEqual({
      mode: 'single',
      entries: [{ strategy_id: 'scope-content', quota_gb: 0 }],
      overflow: 'switch',
    });
    expect(storage.allocations?.attachment.entries[0].strategy_id).toBe('local');
  });
});

describe('legacy migration', () => {
  it('turns a legacy local config into one local strategy', () => {
    const storage = normalizeStorage({ driver: 'ftp' } as never);
    expect(storage.strategies).toHaveLength(1);
    expect(storage.strategies[0]).toMatchObject({
      id: 'local',
      name: '本地储存',
      driver: 'local',
      local_dir: './data/media',
    });
    for (const scope of STORAGE_SCOPES) {
      expect(storage.scopes[scope]).toBe('local');
    }
  });

  it('turns a legacy global S3 config into the cloud strategy', () => {
    const storage = normalizeStorage({
      driver: 's3',
      s3_bucket: 'practacu-press',
      s3_region: 'ap-southeast-1',
      s3_endpoint: 'https://minio.example.com',
      s3_prefix: 'sites/main',
      s3_access_key: 'AKIAEXAMPLE',
      s3_public_base_url: 'https://cdn.example.com',
    } as never);
    expect(storage.strategies).toHaveLength(1);
    expect(storage.strategies[0]).toMatchObject({
      id: 'cloud',
      name: '云对象存储',
      driver: 's3',
      s3_bucket: 'practacu-press',
      s3_region: 'ap-southeast-1',
      s3_endpoint: 'https://minio.example.com',
      s3_prefix: 'sites/main',
      s3_access_key: 'AKIAEXAMPLE',
      s3_public_base_url: 'https://cdn.example.com',
    });
    for (const scope of STORAGE_SCOPES) {
      expect(storage.scopes[scope]).toBe('cloud');
    }
  });

  it('turns each legacy scope override into its own strategy', () => {
    const storage = normalizeStorage({
      driver: 's3',
      local_dir: '  /srv/press/media/  ',
      s3_endpoint: 'https://minio.example.com/',
      s3_region: ' ap-southeast-1 ',
      s3_bucket: '  practacu-press ',
      s3_prefix: '/sites/main/',
      s3_public_base_url: 'https://cdn.example.com/media/',
      s3_access_key: ' AKIAEXAMPLE ',
      media_user_quota_bytes: 0,
      media_user_article_bytes: 0,
      media_user_upload_bytes: 0,
      scopes: {
        content: { driver: 'local', local_dir: '/srv/content/', s3_bucket: '', s3_prefix: '' },
        site: { driver: 's3', local_dir: '', s3_bucket: '/site-bucket/', s3_prefix: '/media/' },
        avatar: { driver: 'ftp' },
        attachment: { driver: 'inherit' },
      },
    } as never);

    expect(storage.media_user_quota_bytes).toBe(0);
    expect(storage.strategies.map((strategy) => strategy.id)).toEqual([
      'cloud',
      'scope-content',
      'scope-site',
    ]);

    const [global, content, site] = storage.strategies;
    expect(global).toMatchObject({
      id: 'cloud',
      local_dir: '/srv/press/media',
      s3_endpoint: 'https://minio.example.com',
      s3_region: 'ap-southeast-1',
      s3_bucket: 'practacu-press',
      s3_prefix: 'sites/main',
      s3_public_base_url: 'https://cdn.example.com/media',
      s3_access_key: 'AKIAEXAMPLE',
    });
    expect(content).toMatchObject({
      id: 'scope-content',
      name: '文章媒体专用',
      driver: 'local',
      local_dir: '/srv/content',
      s3_bucket: '',
    });
    expect(site).toMatchObject({
      id: 'scope-site',
      name: '站点图片专用',
      driver: 's3',
      s3_bucket: 'site-bucket',
      s3_prefix: 'media',
      // 旧覆盖沿用全局的 endpoint / 区域 / 凭据。
      s3_endpoint: 'https://minio.example.com',
      s3_access_key: 'AKIAEXAMPLE',
    });

    expect(storage.scopes.content).toBe('scope-content');
    expect(storage.scopes.site).toBe('scope-site');
    expect(storage.scopes.avatar).toBe('cloud');
    expect(storage.scopes.attachment).toBe('cloud');
  });

  it('survives malformed legacy scope entries', () => {
    const storage = normalizeStorage({
      scopes: { content: null, site: { driver: 's3' } },
    } as never);
    expect(storage.strategies).toHaveLength(2);
    expect(storage.scopes.content).toBe('local');
    expect(storage.scopes.site).toBe('scope-site');
    expect(leftOverIds(storage)).toEqual(['local', 'scope-site']);
  });

  function leftOverIds(settings: StorageSettings): string[] {
    return settings.strategies.map((strategy) => strategy.id);
  }
});

describe('normalizeStrategy', () => {
  it('gives a readable fallback name and sanitizes the id', () => {
    expect(normalizeStrategy({ driver: 's3' }, 'Fig Bed!')).toMatchObject({
      id: 'fig-bed',
      name: '云对象存储',
      driver: 's3',
      s3_region: 'us-east-1',
    });
    expect(normalizeStrategy(undefined, 'local').name).toBe('本地储存');
  });

  it('keeps a legal id untouched', () => {
    expect(normalizeStrategy({ name: 'x' }, 'str_2').id).toBe('str_2');
  });
});

describe('strategy helpers', () => {
  it('finds a strategy and falls back to the first one', () => {
    const settings = allScopes(
      {
        strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', 'COS', 'b')],
        scopes: { content: 'cos', site: 'cos', avatar: 'cos', attachment: 'cos' },
        media_user_quota_bytes: 512 * 1024 * 1024,
        media_user_article_bytes: 0,
        media_user_upload_bytes: 0,
        max_content_chars: 1_000_000,
      },
      'cos',
    );
    expect(findStrategy(settings, 'cos').id).toBe('cos');
    expect(findStrategy(settings, 'missing').id).toBe('local');
  });

  it('describes the location of both drivers', () => {
    expect(strategyLocation(localStrategy('a', 'A'))).toBe(DEFAULT_LOCAL_DIR);
    expect(strategyLocation(localStrategy('a', 'A', '/srv/media'))).toBe('/srv/media');
    expect(strategyLocation(cloudStrategy('b', 'B', ''))).toBe('未填写桶');
    expect(strategyLocation(cloudStrategy('b', 'B', 'bucket'))).toBe('bucket');
    expect(
      strategyLocation({ ...cloudStrategy('b', 'B', 'bucket'), s3_prefix: 'media' }),
    ).toBe('bucket/media');
  });

  it('creates unused ids', () => {
    expect(createStrategyId([])).toBe('str_1');
    expect(createStrategyId([localStrategy('str_1', 'A'), localStrategy('str_2', 'B')])).toBe(
      'str_3',
    );
  });

  it('picks the most used strategy as global and breaks ties by order', () => {
    const strategies = [
      localStrategy('local', '本地储存'),
      cloudStrategy('cos', 'COS', 'b'),
    ];
    const tie: StorageSettings = {
      strategies,
      scopes: { content: 'cos', site: 'cos', avatar: 'local', attachment: 'local' },
      media_user_quota_bytes: 512 * 1024 * 1024,
      media_user_article_bytes: 0,
      media_user_upload_bytes: 0,
      max_content_chars: 1_000_000,
    };
    expect(globalStrategyOf(tie).id).toBe('local');

    const majority: StorageSettings = {
      strategies,
      scopes: { content: 'cos', site: 'cos', avatar: 'cos', attachment: 'local' },
      media_user_quota_bytes: 512 * 1024 * 1024,
      media_user_article_bytes: 0,
      media_user_upload_bytes: 0,
      max_content_chars: 1_000_000,
    };
    expect(globalStrategyOf(majority).id).toBe('cos');
  });

  it('defaults and normalizes the content length ceiling', () => {
    expect(defaultStorage().max_content_chars).toBe(1_000_000);
    expect(normalizeStorage({ ...defaultStorage(), max_content_chars: 250_000 }).max_content_chars).toBe(
      250_000,
    );
    expect(normalizeStorage({ ...defaultStorage(), max_content_chars: 2_000_000 }).max_content_chars).toBe(
      1_000_000,
    );
  });
});

describe('storageUrlError', () => {
  it('accepts empty and http(s) addresses', () => {
    expect(storageUrlError('')).toBe('');
    expect(storageUrlError('https://s3.example.com')).toBe('');
    expect(storageUrlError('http://127.0.0.1:9000')).toBe('');
  });

  it('rejects bare hosts and non-http schemes', () => {
    expect(storageUrlError('s3.example.com')).not.toBe('');
    expect(storageUrlError('ftp://s3.example.com')).not.toBe('');
    expect(storageUrlError('https://')).not.toBe('');
  });
});

describe('buildStorageEnvSnippet', () => {
  it('emits only the local variables for the default settings', () => {
    const snippet = buildStorageEnvSnippet(defaultStorage());
    expect(snippet).toContain('STORAGE_DRIVER=local');
    expect(snippet).toContain('STORAGE_DIR=./data/media');
    expect(snippet).toContain('MAX_CONTENT_SOURCE_CHARS=1000000');
    expect(snippet).not.toMatch(/^STORAGE_S3_BUCKET=/m);
    expect(snippet).toContain('四个用途都使用同一套「本地储存」');
    for (const scope of STORAGE_SCOPES) {
      expect(snippet).not.toMatch(
        new RegExp(`^STORAGE_${scope.toUpperCase()}_DRIVER=`, 'm'),
      );
    }
  });

  it('emits the global S3 variables for the most used strategy', () => {
    const settings = normalizeStorage({
      strategies: [
        localStrategy('local', '本地储存'),
        {
          ...cloudStrategy('cos', '图床 COS', 'practacu-press'),
          s3_region: 'ap-shanghai',
          s3_endpoint: 'https://cos.example.com',
          s3_prefix: 'sites/main',
          s3_access_key: 'AKIDEXAMPLE',
          s3_public_base_url: 'https://cdn.example.com',
        },
      ],
      scopes: { content: 'cos', site: 'cos', avatar: 'cos', attachment: 'local' },
    } as never);

    const snippet = buildStorageEnvSnippet(settings);
    expect(globalStrategyOf(settings).id).toBe('cos');
    expect(snippet).toContain('# 全局段：被最多用途使用的策略「图床 COS」（云对象存储）');
    expect(snippet).toContain('STORAGE_DRIVER=s3');
    expect(snippet).toContain('STORAGE_S3_BUCKET=practacu-press');
    expect(snippet).toContain('STORAGE_S3_REGION=ap-shanghai');
    expect(snippet).toContain('STORAGE_S3_ENDPOINT=https://cos.example.com');
    expect(snippet).toContain('STORAGE_S3_ACCESS_KEY=AKIDEXAMPLE');
    expect(snippet).toContain('STORAGE_S3_PREFIX=sites/main');
    // 秘密只来自页面输入框。
    expect(snippet).not.toMatch(/^STORAGE_S3_SECRET_KEY=/m);
    expect(snippet).toContain('STORAGE_S3_SECRET_KEY=（未填写');
    // 公开访问地址只是记录，不是后端变量。
    expect(snippet).not.toContain('STORAGE_S3_PUBLIC_BASE_URL=');
    expect(snippet).toContain('# 记录用的公开访问地址（API 不读取）：图床 COS → https://cdn.example.com');

    // 剩下的本地用途写成覆盖变量。
    expect(snippet).toContain('STORAGE_ATTACHMENT_DRIVER=local');
    expect(snippet).toContain('STORAGE_ATTACHMENT_LOCAL_DIR=./data/media');
    expect(snippet).not.toMatch(/^STORAGE_CONTENT_DRIVER=/m);
    expect(snippet).toContain('沿用全局策略「图床 COS」的用途：CONTENT / SITE / AVATAR');
  });

  it('keeps the typed secret out of the snippet unless it is provided', () => {
    const settings = normalizeStorage({
      strategies: [cloudStrategy('cloud', '云对象存储', 'practacu-press')],
    } as never);
    expect(buildStorageEnvSnippet(settings)).not.toMatch(/^STORAGE_S3_SECRET_KEY=/m);
    expect(buildStorageEnvSnippet(settings, ' super-secret ')).toContain(
      'STORAGE_S3_SECRET_KEY=super-secret',
    );
  });

  it('marks a missing bucket instead of emitting an empty S3 variable', () => {
    const settings = normalizeStorage({
      strategies: [cloudStrategy('cloud', '云对象存储', '')],
      scopes: { content: 'cloud', site: 'cloud', avatar: 'cloud', attachment: 'cloud' },
    } as never);
    const snippet = buildStorageEnvSnippet(settings);
    expect(snippet).toContain('STORAGE_S3_BUCKET=<必填：桶名，例如 practacu-press>');
    // 区域留空时仍写出 SDK 的默认区域，避免片段无法直接部署。
    expect(snippet).toContain('STORAGE_S3_REGION=us-east-1');
    expect(snippet).toContain('# STORAGE_S3_ENDPOINT=（留空表示 AWS S3');
  });

  it('warns when a cloud scope has no global cloud credentials to inherit', () => {
    const settings = normalizeStorage({
      strategies: [localStrategy('local', '本地储存'), cloudStrategy('cos', 'COS', 'content-bucket')],
      scopes: { content: 'cos', site: 'local', avatar: 'local', attachment: 'local' },
    } as never);
    const snippet = buildStorageEnvSnippet(settings);
    expect(globalStrategyOf(settings).id).toBe('local');
    expect(snippet).toContain('STORAGE_DRIVER=local');
    expect(snippet).not.toMatch(/^STORAGE_S3_BUCKET=/m);
    expect(snippet).toContain('# CONTENT → 策略「COS」（云对象存储）');
    expect(snippet).toContain('STORAGE_CONTENT_DRIVER=s3');
    expect(snippet).toContain('STORAGE_CONTENT_S3_BUCKET=content-bucket');
    expect(snippet).toContain('# STORAGE_CONTENT_S3_PREFIX=（可选：留空写在桶根）');
    expect(snippet).toContain('当前全局策略是本地储存，片段里没有 STORAGE_S3_* 凭据');
  });

  it('notes that several cloud strategies share one set of credentials', () => {
    const settings = normalizeStorage({
      strategies: [
        cloudStrategy('cloud', '云对象存储', 'global-bucket'),
        cloudStrategy('cos', '图床 COS', 'content-bucket'),
      ],
      scopes: { content: 'cos', site: 'cloud', avatar: 'cloud', attachment: 'cloud' },
    } as never);
    const snippet = buildStorageEnvSnippet(settings);
    expect(globalStrategyOf(settings).id).toBe('cloud');
    expect(snippet).toContain('服务器目前只支持一套云凭据');
    expect(snippet).toContain('STORAGE_CONTENT_S3_BUCKET=content-bucket');
    expect(snippet).not.toMatch(/^STORAGE_CONTENT_S3_ENDPOINT=/m);
  });

  it('writes a local directory override for a cloud-scoped migration', () => {
    const settings = normalizeStorage({
      strategies: [
        cloudStrategy('cloud', '云对象存储', 'global-bucket'),
        { ...localStrategy('archive', '归档本地', ''), driver: 'local', local_dir: '' },
      ],
      scopes: { content: 'archive', site: 'cloud', avatar: 'cloud', attachment: 'cloud' },
    } as never);
    const snippet = buildStorageEnvSnippet(settings);
    expect(snippet).toContain('STORAGE_CONTENT_DRIVER=local');
    expect(snippet).toMatch(/^STORAGE_CONTENT_LOCAL_DIR=$/m);
    expect(snippet).toContain('目录留空时由服务器使用默认本地目录');
  });
});
