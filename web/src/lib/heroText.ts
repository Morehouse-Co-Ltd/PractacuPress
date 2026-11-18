/** 首屏标题解析：换行即换行，*文字* 作为强调片段。 */

export interface HeroSegment {
  text: string;
  em: boolean;
}

/** 把首屏标题拆成“行 → 片段”。 */
export function heroLines(title: string): HeroSegment[][] {
  return title
    .split('\n')
    .slice(0, 4)
    .map((line) => {
      const segments: HeroSegment[] = [];
      let cursor = 0;
      for (const match of line.matchAll(/\*([^*]+)\*/g)) {
        const start = match.index ?? 0;
        if (start > cursor) segments.push({ text: line.slice(cursor, start), em: false });
        segments.push({ text: match[1], em: true });
        cursor = start + match[0].length;
      }
      if (cursor < line.length) segments.push({ text: line.slice(cursor), em: false });
      return segments.length ? segments : [{ text: '', em: false }];
    });
}
