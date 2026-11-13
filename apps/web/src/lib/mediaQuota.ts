import type { MediaQuotaBytes } from '../types';

const MAX_MEDIA_QUOTA_BYTES = '9223372036854775807';
const MAX_SAFE_MEDIA_QUOTA_BYTES = '9007199254740991';

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
