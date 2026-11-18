import type { MediaQuotaBytes } from '../types';

const MAX_MEDIA_QUOTA_BYTES = '9223372036854775807';
const MAX_SAFE_MEDIA_QUOTA_BYTES = '9007199254740991';

/**
 * 1 MB = 1024 × 1024 字节。
 *
 * 界面按 MB 输入与展示，存储与接口始终是字节（int64）——换算只发生在这一层。
 */
export const BYTES_PER_MB = 1024 * 1024;

/** 展示用的最多小数位数：6 位 ≈ 1 字节，足够让任意非零额度都不会显示成 0。 */
const MB_FRACTION_DIGITS = 6;
const BYTES_PER_MB_BIG = 1048576n;
const MB_FRACTION_SCALE = 10n ** BigInt(MB_FRACTION_DIGITS);

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function normalizeMediaQuotaDecimal(raw: string): string | null {
  if (!/^\d+$/.test(raw)) return null;

  const normalized = raw.replace(/^0+/, '') || '0';
  return compareDecimalStrings(normalized, MAX_MEDIA_QUOTA_BYTES) <= 0 ? normalized : null;
}

export function mediaQuotaExceedsSafeInteger(raw: string): boolean {
  const normalized = raw.replace(/^0+/, '') || '0';
  return compareDecimalStrings(normalized, MAX_SAFE_MEDIA_QUOTA_BYTES) > 0;
}

/**
 * 把字节数格式化成 MB 字符串（只用于展示与输入框回填）。
 *
 * - `null` / `undefined` / 非数字 / 负数 → `''`（表示继承部署默认，不渲染半个数字）
 * - 用 BigInt 做纯整数运算，int64 大值也精确，不受 Number 的 2^53 限制
 * - 最多 6 位小数，四舍五入后去掉末尾的 0：`1073741824` → `"1024"`、`1572864` → `"1.5"`
 * - 结果只依赖输入数字本身（不经过 `toLocaleString`），输入框里打字时不会被本地化格式干扰
 */
export function bytesToMbString(bytes: MediaQuotaBytes | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  const raw =
    typeof bytes === 'number'
      ? Number.isFinite(bytes) && bytes >= 0
        ? String(Math.trunc(bytes))
        : ''
      : bytes.trim();
  if (!/^\d+$/.test(raw)) return '';

  const total = BigInt(raw);
  let whole = total / BYTES_PER_MB_BIG;
  let fraction =
    ((total % BYTES_PER_MB_BIG) * MB_FRACTION_SCALE + BYTES_PER_MB_BIG / 2n) / BYTES_PER_MB_BIG;
  if (fraction === MB_FRACTION_SCALE) {
    // 四舍五入把小数进位成整数 MB。
    whole += 1n;
    fraction -= MB_FRACTION_SCALE;
  }
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(MB_FRACTION_DIGITS, '0').replace(/0+$/, '');
  return `${whole}.${digits}`;
}

/**
 * 解析界面里以 MB 为单位的输入。
 *
 * - `''` → 继承部署默认（`null`）；`'0'` → 无限（0 字节）
 * - 允许小数（`1.5` → 1572864 字节），按 `Math.round` 四舍五入成整数字节
 * - 负号、NaN、指数写法、千分位等一律无效；换算成字节后必须是安全整数，
 *   否则视为超出可存储上限
 */
export function parseMediaQuotaMbInput(
  raw: string,
): { valid: true; value: number | null } | { valid: false } {
  const text = raw.trim();
  if (text === '') return { valid: true, value: null };
  // 只接受十进制数字，最多一个小数点；负号、+、e、空格都在这里被挡掉。
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return { valid: false };
  const mb = Number(text);
  if (!Number.isFinite(mb) || mb < 0) return { valid: false };
  const bytes = Math.max(0, Math.round(mb * BYTES_PER_MB));
  if (!Number.isFinite(bytes) || !Number.isSafeInteger(bytes)) return { valid: false };
  return { valid: true, value: bytes };
}

/** Parse an exact byte count, keeping large values as decimal strings. */
export function parseMediaQuotaInput(raw: string):
  | { valid: true; value: MediaQuotaBytes }
  | { valid: false } {
  if (raw === '') return { valid: true, value: null };
  const normalized = normalizeMediaQuotaDecimal(raw);
  if (normalized === null) return { valid: false };
  if (!mediaQuotaExceedsSafeInteger(normalized)) {
    return { valid: true, value: Number(normalized) };
  }
  return { valid: true, value: normalized };
}
