/**
 * 「版面已自动升级」的一次性通知（规格 §5.1）。
 *
 * 读取路径会把 v1 的分端编排折算成 `at` 覆盖，并删掉被折算的设备树；像素宽也会折成
 * 栅格占位。这些都是**改写作者的布局**，所以迁移器会把做过的事写成一份中文报告
 * （`migrate.ts` 的 `MigrationResult.report`）。报告原先只留在读取函数的局部变量里，
 * 用户永远看不到——这个模块负责把报告从读取路径交到后台界面手上。
 *
 * 三条约定：
 * - 报告只存在模块内存里，不进 localStorage：它描述的是「这一次读取发生了什么」，
 *   跨刷新重放没有意义；也只有模块内存在匿名访客的读取路径上是安全的（访客不该被写存储）。
 * - `takeMigrationReport()` 取走即清空，所以同一会话里两个组件先后挂载，只有一个会弹窗。
 * - 「已经看过」按报告的**签名**记在 localStorage 里（而不是「弹过窗」），同一份迁移
 *   结论只打扰一次；换了迁移内容（例如另一次版本升级又折了别的页面）还会再提示一次。
 */

/** 已读签名的存储键；版本化，方便以后改签名算法时直接换键。 */
export const SEEN_KEY = 'pp.migrationReport.seen.v1';

/** 最多记住多少个签名；再旧的迁移不该继续压着新提示。 */
export const MAX_SEEN_SIGNATURES = 20;

/** 待取走的报告。空数组表示「这次读取没改写任何东西」，界面上就是什么都不发生。 */
let pending: string[] = [];

/** localStorage 不可用时的退化存储；同时保证本次会话内不会重复提示。 */
let memorySeen: string[] = [];

/**
 * localStorage 是否已经不可用。
 *
 * 一旦读写失败（隐私模式、配额满、被策略禁用）就一直走内存：混合使用两处存储会让
 * 「刚记下已读、下一次读取又只看到旧列表」这种抖动变成重复弹窗。
 */
let degraded = false;

/** 拿到可用的 localStorage；隐私模式下访问 `window.localStorage` 本身就会抛。 */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    degraded = true;
    return null;
  }
}

/** 存一份报告，等界面取走。空报告（没有迁移）不覆盖已有内容，也不留痕迹。 */
export function publishMigrationReport(report: string[]): void {
  if (!Array.isArray(report)) return;
  const lines = report.filter((line): line is string => typeof line === 'string' && !!line.trim());
  if (!lines.length) return;
  pending = lines;
}

/** 取走最近一次发布的报告并清空；没有报告时返回空数组。 */
export function takeMigrationReport(): string[] {
  const report = pending;
  pending = [];
  return report;
}

/**
 * 报告的稳定短签名。
 *
 * 逐行 join 之后过一个 FNV-1a 32 位散列：同一组报告行（同一顺序）得到同一个签名，
 * 行内容或行数不同就会变。这里不需要抗碰撞——最坏情况是两份不同的报告互相压制，
 * 代价只是少弹一次提示，而收益是签名足够短，20 条也不会把存储写大。
 */
export function migrationReportSignature(report: string[]): string {
  const joined = Array.isArray(report) ? report.join('\n') : '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // 长度一起带上：长度为 0（空报告）与散列恰好为 0 都不会被误当成同一个签名。
  return `${joined.length.toString(36)}-${hash.toString(36)}`;
}

/** 读已读列表；读不到（坏 JSON / 存储禁用）时退回内存那一份。 */
function readSeen(): string[] {
  if (degraded) return [...memorySeen];
  const store = storage();
  if (!store) return [...memorySeen];
  try {
    const raw = store.getItem(SEEN_KEY);
    if (!raw) {
      memorySeen = [];
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      memorySeen = [];
      return [];
    }
    const seen = parsed
      .filter((item): item is string => typeof item === 'string' && !!item)
      .slice(-MAX_SEEN_SIGNATURES);
    memorySeen = seen;
    return [...seen];
  } catch {
    // 坏 JSON 或被禁用：继续用内存，别让「已读」这件事把界面搞崩。
    degraded = true;
    return [...memorySeen];
  }
}

/** 写已读列表；写不进去（配额 / 隐私模式）就只留内存。 */
function writeSeen(signatures: string[]): void {
  const capped = signatures.slice(-MAX_SEEN_SIGNATURES);
  memorySeen = capped;
  if (degraded) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SEEN_KEY, JSON.stringify(capped));
  } catch {
    degraded = true;
  }
}

/** 这份报告是否已经提示过。空签名一律当作「没看过」。 */
export function hasSeenMigrationReport(signature: string): boolean {
  if (!signature) return false;
  return readSeen().includes(signature);
}

/**
 * 记下「这份报告已经提示过」。
 *
 * 只由管理后台的弹窗调用：访客的读取路径也会发布报告，但访客不该被写浏览器存储。
 * 重复标记会把签名移到队尾，超出上限时淘汰最旧的那条。
 */
export function markMigrationReportSeen(signature: string): void {
  if (!signature) return;
  const seen = readSeen();
  const next = seen.filter((item) => item !== signature);
  next.push(signature);
  writeSeen(next);
}
