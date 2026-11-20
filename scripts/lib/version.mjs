/**
 * Practacu Press 版本口径的**唯一 Node 实现**（发布脚本共用）。
 *
 * 规则与 `internal/version/version.go`、`web/src/lib/version.ts` 逐条一致，
 * 以 `internal/version/version.go` 为准：
 *
 *   - 只有两种版本：稳定版 `MAJOR.MINOR.PATCH`；
 *     测试版 `MAJOR.MINOR.PATCH-beta` / `MAJOR.MINOR.PATCH-beta.N`
 *   - `version_code = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + STAGE`
 *     `STAGE = 99`（稳定版）或 `N`（测试版序号 1..98）；裸 `-beta` 是第 1 个。
 *   - 输入允许 `v`/`V` 前缀与 `-beta1` / `-beta.1` / `-beta.01`，存储一律规范化：
 *     `-beta1` → `-beta`，`-beta.02` → `-beta.2`。
 *   - 版本比较**只认 `version_code`**；字符串只用于展示与生成 tag。
 *
 * 发布脚本（release-version / stamp-version / package-*）禁止再维护自己的
 * 版本正则，只能从本模块 import。
 */

/** 稳定版的 STAGE 编号（测试版用 1..98）。 */
export const STABLE_STAGE = 99;

/** 测试版序号上限（含）。 */
export const MAX_BETA = 98;

const MAX_MAJOR = 999;
const MAX_MINOR = 99;
const MAX_PATCH = 99;

/** 严格匹配整串版本号；分组：major, minor, patch, beta 序号（可能缺失）。 */
const VERSION_PATTERN =
  /^[vV]?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-beta(?:[.-]?(\d{1,2}))?)?$/;

/**
 * 从任意文本（提交信息、release 标题等）里找版本号用的宽松匹配。
 *
 * 只认带 `v`/`V` 前缀的写法：提交信息里 `Node 22.12.3` 这类裸数字不能被当成
 * 发布版本，否则任何 bump 依赖的提交都会误触发发布。边界断言保证
 * `v1.2.3.4`、`1v1.2.3`、`v1.2.3-rc1` 这类文本不会命中。
 */
const MESSAGE_VERSION_PATTERN =
  /(?<![0-9A-Za-z])[vV]\d{1,3}\.\d{1,2}\.\d{1,2}(?:-beta(?:[.-]?\d{1,2})?)?(?![0-9A-Za-z])(?!\.\d)(?!-[0-9A-Za-z])/g;

/**
 * 解析版本号。
 *
 * @param {unknown} raw 例如 `v0.1.2-beta1`、`V1.0.1-beta.02`、`1.2.3`。
 * @returns {{version: string, channel: 'stable' | 'beta', code: number,
 *            prerelease: boolean, tag: string} | null}
 *          `null` 表示不符合版本口径（调用方必须 fail-closed）。
 */
export function parseVersion(raw) {
  const value = String(raw ?? '').trim();
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > MAX_MAJOR || minor > MAX_MINOR || patch > MAX_PATCH) return null;

  // 与 Go 的实现一致：出现 -beta 就是测试版，裸 -beta 视为第 1 个。
  let beta = 0;
  if (value.includes('-beta')) {
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
    prerelease: beta > 0,
    tag: `v${version}`,
  };
}

/**
 * 整数版本号；非法输入返回 0（与 web/src/lib/version.ts 的 versionCodeOf 一致）。
 */
export function versionCodeOf(raw) {
  const parsed = parseVersion(raw);
  return parsed ? parsed.code : 0;
}

/**
 * 比较两个版本号（可带 v）：a > b 返回正数，相等 0，非法一律 0。
 * 只比较 `version_code`，不比较字符串。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  return Math.sign(left.code - right.code);
}

/**
 * 在任意文本里查找第一个合法的版本号（只认 v 前缀，见 MESSAGE_VERSION_PATTERN）。
 *
 * @param {unknown} text
 * @returns {ReturnType<typeof parseVersion>} 找到返回解析结果，否则返回 null。
 */
export function findVersion(text) {
  const value = String(text ?? '');
  for (const match of value.matchAll(MESSAGE_VERSION_PATTERN)) {
    const parsed = parseVersion(match[0]);
    if (parsed) return parsed;
  }
  return null;
}
