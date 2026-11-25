import { describe, expect, it } from 'vitest';
import type { StorageSettings, StorageStatus, StorageStrategy } from '../types';
import { defaultStorage, emptyStrategy, storageSettingsFromStatus } from './storage';

/** 一套云策略；服务端状态里只保留 has_access_key / has_secret。 */
function cloudStrategy(): StorageStrategy {
  return {
    ...emptyStrategy(),
    id: 'cos',
    name: '图床 COS',
    driver: 's3',
    local_dir: '',
    s3_bucket: 'practacu-press',
    s3_prefix: 'sites/main',
    s3_endpoint: 'https://cos.example.com',
    s3_region: 'ap-shanghai',
    s3_access_key: 'AKIDEXAMPLE',
    s3_public_base_url: 'https://cdn.example.com/media',
  };
}

/** 本机缓存：有 Access Key 与公开地址，服务端不会回传这两个值。 */
function cachedSettings(): StorageSettings {
  const local = defaultStorage();
  return {
    ...local,
    strategies: [local.strategies[0], cloudStrategy()],
    scopes: { content: 'cos', site: 'cos', avatar: 'local', attachment: 'cos' },
    // 旧配置没有 allocations：这里模拟真正的旧对象，避免默认分配盖掉 scopes。
    allocations: undefined,
    media_user_quota_bytes: 99,
  };
}

/** 服务端运行期状态：两套策略 + content 的多策略配额。 */
function runtimeStatus(): StorageStatus {
  const local = defaultStorage().strategies[0];
  return {
    live: true,
    source: 'saved',
    updated_at: '2026-01-02T03:04:05Z',
    max_content_chars: 450_000,
    global_strategy_id: 'cos',
    strategies: [
      {
        id: local.id,
        name: local.name,
        driver: 'local',
        local_dir: './data/media',
        s3_bucket: '',
        s3_prefix: '',
        s3_endpoint: '',
        s3_region: 'us-east-1',
        has_access_key: false,
        has_secret: false,
      },
      {
        id: 'cos',
        name: '图床 COS',
        driver: 's3',
        local_dir: '',
        s3_bucket: 'practacu-press',
        s3_prefix: 'sites/main',
        s3_endpoint: 'https://cos.example.com',
        s3_region: 'ap-shanghai',
        has_access_key: true,
        has_secret: true,
      },
    ],
    scopes: { content: 'cos', site: 'cos', avatar: 'local', attachment: 'cos' },
    allocations: {
      content: {
        mode: 'quota',
        entries: [
          { strategy_id: 'cos', quota_gb: 10, used_bytes: 5_000_000_000, current: true },
          { strategy_id: 'local', quota_gb: 0, used_bytes: 0, current: false },
        ],
        overflow: 'switch',
      },
      site: {
        mode: 'single',
        entries: [{ strategy_id: 'cos', quota_gb: 0, used_bytes: 0, current: true }],
        overflow: 'stop',
      },
      avatar: {
        mode: 'single',
        entries: [{ strategy_id: 'local', quota_gb: 0, used_bytes: 0, current: true }],
        overflow: 'switch',
      },
      attachment: {
        mode: 'quota',
        entries: [{ strategy_id: 'cos', quota_gb: 3, used_bytes: 1, current: true }],
        overflow: 'stop',
      },
    },
    effective: [],
  };
}

describe('storageSettingsFromStatus', () => {
  it('以服务端策略与分配为准，同时沿用本机缓存的凭据', () => {
    const settings = storageSettingsFromStatus(runtimeStatus(), cachedSettings());

    expect(settings.strategies.map((strategy) => strategy.id)).toEqual(['local', 'cos']);
    expect(settings.strategies[1].s3_access_key).toBe('AKIDEXAMPLE');
    expect(settings.max_content_chars).toBe(450_000);
    expect(settings.strategies[1].s3_public_base_url).toBe('https://cdn.example.com/media');
    expect(settings.scopes).toEqual({
      content: 'cos',
      site: 'cos',
      avatar: 'local',
      attachment: 'cos',
    });
    expect(settings.allocations?.content.mode).toBe('quota');
    expect(settings.allocations?.content.entries).toEqual([
      { strategy_id: 'cos', quota_gb: 10 },
      { strategy_id: 'local', quota_gb: 0 },
    ]);
    expect(settings.allocations?.site.overflow).toBe('stop');
    expect(settings.media_user_quota_bytes).toBe(99);
  });

  it('没有服务端策略时退回本机设置', () => {
    const cached = cachedSettings();
    const settings = storageSettingsFromStatus(
      { ...runtimeStatus(), strategies: [] },
      cached,
    );
    expect(settings.strategies.map((strategy) => strategy.id)).toEqual(['local', 'cos']);
    expect(settings.scopes).toEqual(cached.scopes);
  });
});
