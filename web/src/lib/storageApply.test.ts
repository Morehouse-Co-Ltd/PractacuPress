import { describe, expect, it } from 'vitest';
import type { StorageSettings, StorageScopeAllocation } from '../types';
import {
  STORAGE_SCOPES,
  defaultStorage,
  emptyStrategy,
  storageApplyPayload,
  storageApplySignature,
} from './storage';

/** 一套本地策略的最小形状。 */
function localStrategy() {
  return {
    ...emptyStrategy(),
    id: 'local',
    name: '本地储存',
    driver: 'local' as const,
    local_dir: './data/media',
  };
}

/** 一套云策略；Access Key 非空，Secret 只从草稿来。 */
function cloudStrategy() {
  return {
    ...emptyStrategy(),
    id: 'cos',
    name: '图床 COS',
    driver: 's3' as const,
    local_dir: '',
    s3_bucket: 'practacu-press',
    s3_prefix: 'sites/main',
    s3_endpoint: 'https://cos.example.com',
    s3_region: 'ap-shanghai',
    s3_access_key: 'AKIDEXAMPLE',
    s3_public_base_url: 'https://cdn.example.com/media',
  };
}

/**
 * 两套策略 + 多策略分配：
 * - content：quota 模式，先写 cos（上限 10 GB），再切到 local；
 * - site / attachment：单策略 / quota-stop，用来验证 mode 与 overflow 原样提交。
 */
function multiStrategySettings(): StorageSettings {
  return {
    strategies: [localStrategy(), cloudStrategy()],
    scopes: { content: 'cos', site: 'cos', avatar: 'local', attachment: 'cos' },
    allocations: {
      content: {
        mode: 'quota',
        entries: [
          { strategy_id: 'cos', quota_gb: 10 },
          { strategy_id: 'local', quota_gb: 0 },
        ],
        overflow: 'switch',
      },
      site: {
        mode: 'single',
        entries: [{ strategy_id: 'cos', quota_gb: 0 }],
        overflow: 'switch',
      },
      avatar: {
        mode: 'single',
        entries: [{ strategy_id: 'local', quota_gb: 0 }],
        overflow: 'switch',
      },
      attachment: {
        mode: 'quota',
        entries: [{ strategy_id: 'cos', quota_gb: 0 }],
        overflow: 'stop',
      },
    },
    max_upload_mb: 99,
    max_content_chars: 1_000_000,
  };
}

/** 换掉某个用途的分配，其余保持不变。 */
function withAllocation(
  settings: StorageSettings,
  scope: (typeof STORAGE_SCOPES)[number],
  allocation: StorageScopeAllocation,
): StorageSettings {
  return {
    ...settings,
    allocations: { ...settings.allocations!, [scope]: allocation },
  };
}

describe('storageApplyPayload', () => {
  it('sends the default local strategy for all four scopes', () => {
    const payload = storageApplyPayload(defaultStorage());
    expect(payload.global_strategy_id).toBe('local');
    expect(payload.max_content_chars).toBe(1_000_000);
    expect(payload.strategies).toEqual([
      {
        id: 'local',
        name: '本地储存',
        driver: 'local',
        local_dir: './data/media',
        s3_bucket: '',
        s3_prefix: '',
        s3_endpoint: '',
        s3_region: 'us-east-1',
        s3_access_key: '',
      },
    ]);
    expect(payload.scopes).toEqual({
      content: 'local',
      site: 'local',
      avatar: 'local',
      attachment: 'local',
    });
    for (const scope of STORAGE_SCOPES) {
      expect(payload.allocations[scope]).toEqual({
        mode: 'single',
        entries: [{ strategy_id: 'local', quota_gb: 0 }],
        overflow: 'switch',
      });
    }
    // 没有输入密钥时请求里不能出现这个字段。
    expect(payload.strategies[0]).not.toHaveProperty('s3_secret_key');
  });

  it('carries allocations, primary scopes and only non-empty secret drafts', () => {
    const settings = multiStrategySettings();
    const payload = storageApplyPayload(settings, {
      cos: '  s3cr3t-value  ',
      local: '   ',
    });

    // 全局策略 = 被最多用途使用的那套（cos 3 个用途）。
    expect(payload.global_strategy_id).toBe('cos');
    // scopes 取每个用途写入顺序的第一套。
    expect(payload.scopes).toEqual({
      content: 'cos',
      site: 'cos',
      avatar: 'local',
      attachment: 'cos',
    });
    // 配额、顺序与 overflow 原样提交给服务端。
    expect(payload.allocations.content).toEqual({
      mode: 'quota',
      entries: [
        { strategy_id: 'cos', quota_gb: 10 },
        { strategy_id: 'local', quota_gb: 0 },
      ],
      overflow: 'switch',
    });
    expect(payload.allocations.attachment.overflow).toBe('stop');

    // 只有 cos 有非空草稿：去空白后随请求提交；local 的空白草稿不出现。
    const [local, cloud] = payload.strategies;
    expect(local).not.toHaveProperty('s3_secret_key');
    expect(cloud.s3_secret_key).toBe('s3cr3t-value');
    expect(cloud.s3_endpoint).toBe('https://cos.example.com');
    expect(cloud.s3_access_key).toBe('AKIDEXAMPLE');

    // 页面提示字段不上线：上传上限与公开访问地址都不发给服务端。
    const json = JSON.stringify(payload);
    expect(json).not.toContain('max_upload_mb');
    expect(json).not.toContain('cdn.example.com');
    expect(json).not.toContain('s3_public_base_url');
  });

  it('derives the primary scope from the allocation order, not the stale scopes field', () => {
    const settings = multiStrategySettings();
    // 故意写一个与分配顺序不一致的 scopes：第一套才是真正的主策略。
    const payload = storageApplyPayload({ ...settings, scopes: { ...settings.scopes, content: 'local' } });
    expect(payload.scopes.content).toBe('cos');
  });
});

describe('storageApplySignature', () => {
  it('is stable for equal settings and ignores page-only hints', () => {
    const settings = multiStrategySettings();
    const first = storageApplySignature(settings);
    expect(storageApplySignature(multiStrategySettings())).toBe(first);
    // 副本（结构和值相同）也必须得到相同签名。
    expect(storageApplySignature(JSON.parse(JSON.stringify(settings)) as StorageSettings)).toBe(
      first,
    );

    // 只改上传提示与公开访问地址：不影响「写到哪里」。
    const hintsOnly: StorageSettings = {
      ...settings,
      max_upload_mb: 2048,
      strategies: settings.strategies.map((strategy) => ({
        ...strategy,
        s3_public_base_url: 'https://cdn2.example.com/media',
      })),
    };
    expect(storageApplySignature(hintsOnly)).toBe(first);
  });

  it('changes when quotas, mode, order or overflow change', () => {
    const settings = multiStrategySettings();
    const base = storageApplySignature(settings);
    const content = settings.allocations!.content;

    const quotaChanged = withAllocation(settings, 'content', {
      ...content,
      entries: [
        { strategy_id: 'cos', quota_gb: 50 },
        { strategy_id: 'local', quota_gb: 0 },
      ],
    });
    expect(storageApplySignature(quotaChanged)).not.toBe(base);

    const modeChanged = withAllocation(settings, 'content', {
      ...content,
      mode: 'single',
    });
    expect(storageApplySignature(modeChanged)).not.toBe(base);

    const orderChanged = withAllocation(settings, 'content', {
      ...content,
      entries: [content.entries[1], content.entries[0]],
    });
    expect(storageApplySignature(orderChanged)).not.toBe(base);

    const overflowChanged = withAllocation(settings, 'attachment', {
      ...settings.allocations!.attachment,
      overflow: 'switch',
    });
    expect(storageApplySignature(overflowChanged)).not.toBe(base);
  });

  it('changes when the content length ceiling changes', () => {
    const settings = multiStrategySettings();
    const current = storageApplySignature(settings);
    expect(storageApplySignature({ ...settings, max_content_chars: 300_000 })).not.toBe(current);
  });

  it('changes when the target or credentials change, but never contains the secret', () => {
    const settings = multiStrategySettings();
    const base = storageApplySignature(settings);

    const bucketChanged: StorageSettings = {
      ...settings,
      strategies: settings.strategies.map((strategy) =>
        strategy.id === 'cos' ? { ...strategy, s3_bucket: 'another-bucket' } : strategy,
      ),
    };
    expect(storageApplySignature(bucketChanged)).not.toBe(base);

    const accessKeyChanged: StorageSettings = {
      ...settings,
      strategies: settings.strategies.map((strategy) =>
        strategy.id === 'cos' ? { ...strategy, s3_access_key: 'AKIDROTATED' } : strategy,
      ),
    };
    expect(storageApplySignature(accessKeyChanged)).not.toBe(base);

    // Secret 只存在于组件状态，签名里不能出现它的任何痕迹。
    expect(base).not.toContain('s3cr3t');
    expect(base).not.toContain('s3_secret_key');
  });
});
