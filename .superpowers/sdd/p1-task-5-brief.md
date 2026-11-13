### Task 5: 鍍忕礌瀹芥姌绠楁垚鏍呮牸鍒?
**Files:**
- Modify: `apps/web/src/lib/customize.ts`
- Modify: `apps/web/src/lib/blocks.ts`
- Test: `apps/web/src/lib/widthToSpan.test.ts`锛堟柊寤猴級

**Interfaces:**
- Produces: `widthToSpan(width: number, containerWidth: number, columns: number): number`鈥斺€旂函鍑芥暟銆?- Produces: `migrateWidthsToSpan(blocks: BlockInstance[], containerWidth: number): BlockInstance[]`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// apps/web/src/lib/widthToSpan.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { migrateWidthsToSpan, widthToSpan } from './blocks';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('widthToSpan', () => {
  it('鍗婂鎹㈢畻鎴?6 鏍?, () => {
    expect(widthToSpan(600, 1200, 12)).toBe(6);
  });
  it('鍚戜笂鍙栨暣锛岄伩鍏嶇獎鍧楃畻鍑?0 鏍?, () => {
    expect(widthToSpan(10, 1200, 12)).toBe(1);
  });
  it('瓒呰繃瀹瑰櫒瀹藉す鍒版弧鏍?, () => {
    expect(widthToSpan(5000, 1200, 12)).toBe(12);
  });
  it('鍧忚緭鍏ヨ繑鍥炴弧鏍?, () => {
    expect(widthToSpan(Number.NaN, 1200, 12)).toBe(12);
    expect(widthToSpan(600, 0, 12)).toBe(12);
  });
});

describe('migrateWidthsToSpan', () => {
  it('鏈?width 鐨勫尯鍧楄鎹㈡垚 span 骞舵竻鎺?width', () => {
    const blocks = [mk('a', { width: 600 }), mk('b')];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].span).toEqual({ base: 6 });
    expect(next[0].width).toBeUndefined();
    expect(next[1].span).toBeUndefined();
  });
  it('宸茬粡鏈?span 鐨勫尯鍧椾笉鍔?, () => {
    const blocks = [mk('a', { width: 600, span: { base: 3 } })];
    expect(migrateWidthsToSpan(blocks, 1200)[0]).toEqual(blocks[0]);
  });
  it('閫掑綊杩涘瓙鍖哄潡涓斾笉淇敼鍏ュ弬', () => {
    const child = mk('c', { width: 600 });
    const blocks = [mk('p', { children: [child] })];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].children?.[0].span).toEqual({ base: 6 });
    expect(blocks[0].children?.[0].span).toBeUndefined();
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/widthToSpan.test.ts
```

- [ ] **Step 3: 瀹炵幇**

`blocks.ts` 鏈熬锛?
```ts
/** 鍍忕礌瀹芥姌绠楁垚鏍呮牸鍒楁暟锛涘悜涓婂彇鏁达紝鍧忚緭鍏ユ寜婊℃爮澶勭悊銆?*/
export function widthToSpan(width: number, containerWidth: number, columns = 12): number {
  if (!Number.isFinite(width) || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return columns;
  }
  const raw = Math.ceil((width / containerWidth) * columns);
  return Math.min(columns, Math.max(1, raw));
}

/**
 * 涓€娆℃€ф妸銆屽儚绱犲銆嶆姌绠楁垚銆屾爡鏍煎崰浣嶃€嶃€? *
 * 鍙鐞嗘病鏈?span 鐨勫尯鍧椻€斺€斿凡缁忔湁 span 鐨勮鏄庣敤鎴峰凡缁忔寜鏍呮牸鎺掕繃锛屼笉鍐嶄簩娆℃姌绠椼€? * 杩欐槸 P1 搂5.1 瀹氫笅鐨勪竴娆℃€ц縼绉伙細涓嶄繚鐣欎袱濂楀搴﹁涔夊苟瀛樸€? */
export function migrateWidthsToSpan(
  blocks: BlockInstance[],
  containerWidth: number,
  columns = 12,
): BlockInstance[] {
  return blocks.map((block) => {
    const children = block.children?.length
      ? migrateWidthsToSpan(block.children, containerWidth, columns)
      : block.children;
    const next: BlockInstance = children !== block.children ? { ...block, children } : block;
    if (typeof block.width !== 'number' || block.width <= 0 || block.span) return next;
    const { width: _dropWidth, ...rest } = next;
    return { ...rest, span: { base: widthToSpan(block.width, containerWidth, columns) } };
  });
}
```

- [ ] **Step 4: 鎺ュ埌璇诲彇璺緞**

鍦?`customize.ts` 鐨?`normalizeScreenLayout` 杩斿洖涔嬪墠锛屽 `blocks` 涓庢瘡涓澶囩殑 `blocks`
鍚勮窇涓€娆?`migrateWidthsToSpan(list, 1200)`锛堝鍣ㄥ鎸?1200 鐨勫父瑙勫唴瀹瑰搴︿及绠楋級锛?骞跺姞娉ㄩ噴璇存槑"杩欐槸 搂5.1 鐨勪竴娆℃€ф姌绠?銆?
鍚屾椂鎶?`normalizeBlockAppearance` 鐨?padding 涓婇檺浠?64 鏀惧鍒?96锛堜笌鏍囧昂鏈€澶у€煎榻愶級锛?璇箟浠嶆槸 px銆?
- [ ] **Step 5: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/blocks.ts apps/web/src/lib/widthToSpan.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): fold pixel widths into grid spans once"
```

---

