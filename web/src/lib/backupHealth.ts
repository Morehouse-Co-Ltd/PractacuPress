import type { BackupArtifact } from '../types';

/**
 * 数据与备份页的纯逻辑：健康条只需要「最近一份、总体积、是否含媒体、是否过期」，
 * 这些判断都在这里做，页面只负责排版；不依赖 React，也不发请求。
 */

/** 最近一份备份超过这么多天就算“过期”：默认每日自动备份，一周没新包值得提醒。 */
export const BACKUP_STALE_DAYS = 7;

/** 备份包体积合计；非法体积按 0，不会把 NaN 带进界面。 */
export interface BackupTotals {
  count: number;
  bytes: number;
  withMedia: number;
}

/** 找到创建时间最新的一份；时间戳全部非法时退回数组最后一个（API 通常已倒序）。 */
export function latestBackup(artifacts: BackupArtifact[]): BackupArtifact | null {
  if (!artifacts.length) return null;
  let latest = artifacts[0];
  let latestAt = Date.parse(latest.created_at);
  for (const artifact of artifacts.slice(1)) {
    const at = Date.parse(artifact.created_at);
    if (Number.isFinite(at) && (!Number.isFinite(latestAt) || at > latestAt)) {
      latest = artifact;
      latestAt = at;
    }
  }
  return latest;
}

/** 数量、合计体积与包含媒体的份数。 */
export function backupTotals(artifacts: BackupArtifact[]): BackupTotals {
  let bytes = 0;
  let withMedia = 0;
  for (const artifact of artifacts) {
    if (Number.isFinite(artifact.size) && artifact.size > 0) bytes += artifact.size;
    if (artifact.includes_media) withMedia += 1;
  }
  return { count: artifacts.length, bytes, withMedia };
}

/** 备份包的年龄（整天）；时间戳非法时返回 null。负数（时钟偏差）按 0。 */
export function backupAgeDays(iso?: string, now = Date.now()): number | null {
  if (!iso) return null;
  const created = Date.parse(iso);
  if (!Number.isFinite(created)) return null;
  const diff = Math.max(0, now - created);
  return Math.floor(diff / 86_400_000);
}

export type BackupHealthTone = 'ok' | 'warn' | 'muted';

/**
 * 健康条的色调：没有备份是 muted（还没开始），超过 7 天是 warn（该检查了），
 * 其余是 ok。只在「最近备份」这张卡上使用，不会把整个页面染成警告色。
 */
export function backupHealthTone(
  latest: BackupArtifact | null,
  now = Date.now(),
  staleDays = BACKUP_STALE_DAYS,
): BackupHealthTone {
  if (!latest) return 'muted';
  const age = backupAgeDays(latest.created_at, now);
  if (age === null) return 'muted';
  return age > staleDays ? 'warn' : 'ok';
}
