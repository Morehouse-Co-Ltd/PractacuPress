/**
 * 文案插值与英文复数。
 *
 * 中文原文作键，所以中文侧永远是一条完整句子，只需要把 `{name}` 占位换成值。
 * 英文侧有时要区分单复数，于是英文条目允许写成 `{ one, other }`。
 */

export type Vars = Record<string, string | number>;

/** 英文条目：一条固定文案，或单数/复数两种形式。 */
export type Entry = string | { one: string; other: string };

export type Dictionary = Record<string, Entry>;

/** 把 `{name}` 占位替换成 `vars.name`；取不到值时原样保留，避免出现 `undefined`。 */
export function interpolate(pattern: string, vars?: Vars): string {
  if (!vars) return pattern;
  return pattern.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * 选复数形式。
 *
 * 约定按 `count` 取；没有 `count` 时退回第一个数字变量，都没有就当作复数。
 * 取值 1（含 1.0）用单数，其余用复数——与 `Intl.PluralRules` 对英文的判定一致。
 */
export function pickPlural(
  entry: { one: string; other: string },
  vars?: Vars,
): string {
  return countOf(vars) === 1 ? entry.one : entry.other;
}

function countOf(vars?: Vars): number | null {
  if (!vars) return null;
  const explicit = vars.count;
  if (typeof explicit === 'number') return explicit;
  if (typeof explicit === 'string' && explicit.trim() !== '' && Number.isFinite(Number(explicit))) {
    return Number(explicit);
  }
  for (const value of Object.values(vars)) {
    if (typeof value === 'number') return value;
  }
  return null;
}
