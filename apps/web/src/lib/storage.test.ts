import { describe, expect, it } from 'vitest';
import type { StorageScopeSettings, StorageSettings } from '../types';
import {
  DEFAULT_STORAGE,
  STORAGE_SCOPES,
  buildStorageEnvSnippet,
  normalizeScopeSettings,
  normalizeStorage,
  readStorage,
  storageUrlError,
} from './storage';

const INHERIT: StorageScopeSettings = {
  driver: 'inherit',
  local_dir: '',
  s3_bucket: '',
  s3_prefix: '',
};

function scopes(
  patch: Partial<Record<'content' | 'site' | 'avatar' | 'attachment', StorageScopeSettings>>,
): StorageSettings['scopes'] {
  return {
    content: patch.content ?? { ...INHERIT },
    site: patch.site ?? { ...INHERIT },
    avatar: patch.avatar ?? { ...INHERIT },
    attachment: patch.attachment ?? { ...INHERIT },
  };
}

describe('readStorage', () => {
  it('returns the local defaults for a legacy config', () => {
    expect(readStorage({})).toEqual(DEFAULT_STORAGE);
    expect(readStorage({ storage: undefined })).toEqual(DEFAULT_STORAGE);
  });

  it('has four scopes that all inherit the global storage by default', () => {
    expect(STORAGE_SCOPES).toEqual(['content', 'site', 'avatar', 'attachment']);
    for (const scope of STORAGE_SCOPES) {
      expect(DEFAULT_STORAGE.scopes[scope]).toEqual(INHERIT);
    }
  });

  it('normalizes loose input and clamps the upload hint', () => {
    const storage = normalizeStorage({
      driver: 's3',
      local_dir: '  /srv/press/media/  ',
      s3_endpoint: 'https://minio.example.com/',
      s3_region: ' ap-southeast-1 ',
      s3_bucket: '  practacu-press ',
      s3_prefix: '/sites/main/',
      s3_public_base_url: 'https://cdn.example.com/media/',
      s3_access_key: ' AKIAEXAMPLE ',
      max_upload_mb: 0,
    });
    expect(storage.driver).toBe('s3');
    expect(storage.local_dir).toBe('/srv/press/media');
    expect(storage.s3_endpoint).toBe('https://minio.example.com');
    expect(storage.s3_region).toBe('ap-southeast-1');
    expect(storage.s3_bucket).toBe('practacu-press');
    expect(storage.s3_prefix).toBe('sites/main');
    expect(storage.s3_public_base_url).toBe('https://cdn.example.com/media');
    expect(storage.s3_access_key).toBe('AKIAEXAMPLE');
    expect(storage.max_upload_mb).toBe(1);
  });

  it('falls back to local for an unknown driver', () => {
    expect(normalizeStorage({ driver: 'ftp' as never }).driver).toBe('local');
    expect(normalizeStorage({ driver: 's3' }).driver).toBe('s3');
  });
});

describe('scope settings', () => {
  it('treats a missing scopes field as four inherit entries', () => {
    const legacy = normalizeStorage({
      driver: 's3',
      s3_bucket: 'legacy-bucket',
    });
    for (const scope of STORAGE_SCOPES) {
      expect(legacy.scopes[scope]).toEqual(INHERIT);
    }
  });

  it('normalizes every scope and falls back to inherit for unknown drivers', () => {
    const storage = normalizeStorage({
      scopes: {
        content: {
          driver: 'local',
          local_dir: '/srv/content/',
          s3_bucket: '',
          s3_prefix: '',
        },
        site: {
          driver: 's3',
          local_dir: '',
          s3_bucket: '/site-bucket/',
          s3_prefix: '/media/',
        },
        avatar: {
          driver: 'ftp' as never,
          local_dir: '',
          s3_bucket: '',
          s3_prefix: '',
        },
        attachment: {
          driver: 'inherit',
          local_dir: '',
          s3_bucket: '',
          s3_prefix: '',
        },
      },
    });
    expect(storage.scopes.content).toEqual({
      driver: 'local',
      local_dir: '/srv/content',
      s3_bucket: '',
      s3_prefix: '',
    });
    expect(storage.scopes.site).toEqual({
      driver: 's3',
      local_dir: '',
      s3_bucket: 'site-bucket',
      s3_prefix: 'media',
    });
    expect(storage.scopes.avatar.driver).toBe('inherit');
    expect(storage.scopes.attachment.driver).toBe('inherit');
  });

  it('survives malformed scope entries and partial input', () => {
    const storage = normalizeStorage({
      scopes: { content: null, site: { driver: 's3' } },
    } as never);
    expect(storage.scopes.content.driver).toBe('inherit');
    expect(storage.scopes.site).toEqual({
      driver: 's3',
      local_dir: '',
      s3_bucket: '',
      s3_prefix: '',
    });
    expect(normalizeScopeSettings(undefined)).toEqual(INHERIT);
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
  it('emits local storage variables only', () => {
    const snippet = buildStorageEnvSnippet(DEFAULT_STORAGE);
    expect(snippet).toContain('STORAGE_DRIVER=local');
    expect(snippet).toContain('STORAGE_DIR=./data/media');
    expect(snippet).not.toMatch(/^STORAGE_S3_BUCKET=/m);
  });

  it('emits nothing for scopes that all inherit', () => {
    const snippet = buildStorageEnvSnippet(DEFAULT_STORAGE);
    expect(snippet).toContain('四个用途都沿用全局');
    for (const scope of STORAGE_SCOPES) {
      expect(snippet).not.toMatch(new RegExp(`^STORAGE_${scope.toUpperCase()}_DRIVER=`, 'm'));
    }
  });

  it('emits the S3 variables and keeps the secret out unless typed', () => {
    const settings = normalizeStorage({
      driver: 's3',
      s3_bucket: 'practacu-press',
      s3_region: 'us-east-1',
      s3_endpoint: 'https://minio.example.com',
      s3_prefix: 'sites/main',
      s3_access_key: 'AKIAEXAMPLE',
      s3_public_base_url: 'https://cdn.example.com',
    });
    const withoutSecret = buildStorageEnvSnippet(settings);
    expect(withoutSecret).toContain('STORAGE_DRIVER=s3');
    expect(withoutSecret).toContain('STORAGE_S3_BUCKET=practacu-press');
    expect(withoutSecret).toContain('STORAGE_S3_REGION=us-east-1');
    expect(withoutSecret).toContain('STORAGE_S3_ENDPOINT=https://minio.example.com');
    expect(withoutSecret).toContain('STORAGE_S3_ACCESS_KEY=AKIAEXAMPLE');
    expect(withoutSecret).toContain('STORAGE_S3_PREFIX=sites/main');
    expect(withoutSecret).not.toMatch(/^STORAGE_S3_SECRET_KEY=/m);
    // 公开访问前缀只是记录，不是后端环境变量。
    expect(withoutSecret).not.toContain('STORAGE_S3_PUBLIC_BASE_URL=');
    expect(withoutSecret).toContain('# 记录用的公开访问前缀（API 不读取）：https://cdn.example.com');

    const withSecret = buildStorageEnvSnippet(settings, ' super-secret ');
    expect(withSecret).toContain('STORAGE_S3_SECRET_KEY=super-secret');
  });

  it('leaves the AWS endpoint empty and marks a missing bucket', () => {
    const snippet = buildStorageEnvSnippet(
      normalizeStorage({ driver: 's3', s3_region: '', s3_bucket: '' }),
    );
    expect(snippet).toContain('# STORAGE_S3_ENDPOINT=（留空表示 AWS S3');
    expect(snippet).toContain('STORAGE_S3_BUCKET=<必填：桶名');
    // 区域留空时仍写出 SDK 的默认区域，避免片段无法直接部署。
    expect(snippet).toContain('STORAGE_S3_REGION=us-east-1');
  });

  it('writes only the overridden scopes with their own variables', () => {
    const settings = normalizeStorage({
      driver: 's3',
      s3_bucket: 'global-bucket',
      s3_region: 'ap-southeast-1',
      s3_endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      s3_access_key: 'LTAI5tExample',
      scopes: scopes({
        content: {
          driver: 'local',
          local_dir: '/srv/content/',
          s3_bucket: '',
          s3_prefix: '',
        },
        site: {
          driver: 's3',
          local_dir: '',
          s3_bucket: '/site-bucket/',
          s3_prefix: '/media/',
        },
        avatar: {
          driver: 'local',
          local_dir: '',
          s3_bucket: '',
          s3_prefix: '',
        },
      }),
    });
    const snippet = buildStorageEnvSnippet(settings);

    expect(snippet).toContain('STORAGE_CONTENT_DRIVER=local');
    expect(snippet).toContain('STORAGE_CONTENT_LOCAL_DIR=/srv/content');
    expect(snippet).not.toMatch(/^STORAGE_CONTENT_S3_BUCKET=/m);

    expect(snippet).toContain('STORAGE_SITE_DRIVER=s3');
    expect(snippet).toContain('STORAGE_SITE_S3_BUCKET=site-bucket');
    expect(snippet).toContain('STORAGE_SITE_S3_PREFIX=media');
    // 分用途的 S3 覆盖不重复写 endpoint / 区域 / 凭据。
    expect(snippet).not.toMatch(/^STORAGE_SITE_S3_ENDPOINT=/m);

    // 本地目录留空时仍写出变量，并说明服务器会使用默认目录。
    expect(snippet).toContain('STORAGE_AVATAR_DRIVER=local');
    expect(snippet).toMatch(/^STORAGE_AVATAR_LOCAL_DIR=$/m);
    expect(snippet).toContain('留空时由服务器使用默认本地目录');

    // inherit 的用途不写变量，只在注释里说明。
    expect(snippet).not.toMatch(/^STORAGE_ATTACHMENT_DRIVER=/m);
    expect(snippet).toContain('沿用全局的用途：ATTACHMENT');
    expect(snippet).toContain('分用途的 S3 覆盖沿用全局的 endpoint、区域与凭据');
  });

  it('warns when a scoped S3 override has no global S3 credentials to inherit', () => {
    const settings = normalizeStorage({
      driver: 'local',
      scopes: scopes({
        content: {
          driver: 's3',
          local_dir: '',
          s3_bucket: 'content-bucket',
          s3_prefix: '',
        },
      }),
    });
    const snippet = buildStorageEnvSnippet(settings);
    expect(snippet).toContain('STORAGE_CONTENT_DRIVER=s3');
    expect(snippet).toContain('STORAGE_CONTENT_S3_BUCKET=content-bucket');
    expect(snippet).toContain('# STORAGE_CONTENT_S3_PREFIX=（可选：留空写在桶根）');
    expect(snippet).toContain('当前全局是本地存储');
  });
});
