/**
 * 版本口径的 TypeScript 实现，与 `internal/version/version.go` 必须逐条一致。
 *
 * 只有两种版本：稳定版 `MAJOR.MINOR.PATCH` 与测试版
 * `MAJOR.MINOR.PATCH-beta[.N]`。比较只用整数 `version_code`：
 *
 *   version_code = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + STAGE
 *   STAGE = 99（稳定版） | N（测试版序号 1..98）
 *
 * 字符串只用于展示与生成 tag。规则以 `internal/version/version.go` 为准。
 */

export type VersionChannel = 'stable' | 'beta';

export interface ParsedVersion {
  /** 规范化后的版本号，不带 v，例如 0.1.2-beta.2。 */
  version: string;
  channel: VersionChannel;
  /** 整数版本号，比较只认它。 */
  code: number;
}

const MAX_MINOR = 99;
const MAX_PATCH = 99;
const MAX_BETA = 98;
const STABLE_STAGE = 99;

const VERSION_PATTERN = /^[vV]?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-beta(?:[.-]?(\d{1,2}))?)?$/;

/** 解析版本号；非法输入返回 null（调用方必须 fail-closed）。 */
export function parseVersion(raw: string): ParsedVersion | null {
  const value = String(raw ?? '').trim();
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor > MAX_MINOR || patch > MAX_PATCH) return null;

  const isBeta = /-beta/i.test(value);
  let beta = 0;
  if (isBeta) {
    beta = match[4] === undefined ? 1 : Number(match[4]);
    if (!Number.isInteger(beta) || beta < 1 || beta > MAX_BETA) return null;
  }

  const base = `${major}.${minor}.${patch}`;
  const stage = beta > 0 ? beta : STABLE_STAGE;
  const version = beta > 1 ? `${base}-beta.${beta}` : beta === 1 ? `${base}-beta` : base;
  return {
    version,
    channel: beta > 0 ? 'beta' : 'stable',
    code: major * 1_000_000 + minor * 10_000 + patch * 100 + stage,
  };
}

/** 规范化版本号；非法输入返回 null。 */
export function normalizeVersion(raw: string): string | null {
  return parseVersion(raw)?.version ?? null;
}

/** 整数版本号；非法输入返回 0。 */
export function versionCodeOf(raw: string): number {
  return parseVersion(raw)?.code ?? 0;
}

/** 版本号对应的通道；非法输入返回 null。 */
export function versionChannelOf(raw: string): VersionChannel | null {
  return parseVersion(raw)?.channel ?? null;
}

/** 比较两个版本号（可带 v）：a > b 返回正数，相等 0，非法一律 0。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return Math.sign(left.code - right.code);
}

/** 展示形式：统一加 v 前缀。 */
export function versionLabelOf(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '—';
  return /^[vV]/.test(value) ? `v${value.slice(1)}` : `v${value}`;
}
