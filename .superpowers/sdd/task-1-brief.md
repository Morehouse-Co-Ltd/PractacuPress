### Task 1: 鏍戠害鏉熸敹鏁涗笌涓嬬Щ琛ュ伩

`MAX_BLOCKS` / `MAX_BLOCK_DEPTH` 宸叉槸鍞竴鏉ユ簮锛坄blockTree.ts:10-11`锛夛紝浣嗗瓙瀹瑰櫒涓婇檺 80 鏁ｈ惤鍦?`customize.ts:578`锛屾牴绾?24 鏁ｈ惤鍦?`customize.ts:611`銆傚悓鏃?`moveBlock` 鍦ㄥ悓涓€鐖剁骇鍚戜笅绉诲姩鏃?灏戝噺涓€浣嶏紙瀹¤ W-4锛夈€?
**Files:**
- Modify: `apps/web/src/lib/blockTree.ts:10-11,132-144`
- Test: `apps/web/src/lib/blockTreeMove.test.ts`锛堟柊寤猴級

**Interfaces:**
- Produces: `MAX_CHILDREN_PER_CONTAINER: number`锛堝€间负 80锛夛紝渚?Task 2 鐨勫綊涓€鍖栧紩鐢ㄣ€?- Produces: `moveBlock(blocks, id, target)` 鐨勮涔夋牎姝ｂ€斺€擿target.index` 鐜板湪鏄?绉婚櫎鍚庡簲鎻掑叆鐨勪笅鏍?锛?  鍚屼竴鐖剁骇鍚戜笅绉诲姩鏃惰嚜鍔ㄨˉ鍋裤€傜鍚嶄笉鍙樸€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/blockTreeMove.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { moveBlock } from './blockTree';

function mk(id: string, children: BlockInstance[] = []): BlockInstance {
  return {
    id,
    type: 'text',
    title: id,
    props: {},
    animation: 'none',
    hidden: false,
    ...(children.length ? { children } : {}),
  };
}

function ids(blocks: BlockInstance[]): string[] {
  return blocks.map((block) => block.id);
}

describe('moveBlock 鍚屼竴鐖剁骇鍐呯殑涓嬫爣琛ュ伩', () => {
  it('鏍圭骇鎶?A 鎷栧埌 B 涔嬪悗寰楀埌 [B,A,C]', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'a', { parentId: null, index: 2 });
    expect(ids(next)).toEqual(['b', 'a', 'c']);
  });

  it('鏍圭骇鍚戜笂鎷栧姩浠嶇劧姝ｇ‘', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'c', { parentId: null, index: 0 });
    expect(ids(next)).toEqual(['c', 'a', 'b']);
  });

  it('瀹瑰櫒鍐呭悜涓嬫嫋鍔ㄥ悓鏍疯ˉ鍋?, () => {
    const blocks = [mk('box', [mk('a'), mk('b'), mk('c')])];
    const next = moveBlock(blocks, 'a', { parentId: 'box', index: 2 });
    expect(ids(next[0].children ?? [])).toEqual(['b', 'a', 'c']);
  });

  it('鎷栧埌鑷韩瀛愬瓩閲屼粛鐒惰鎷掔粷', () => {
    const blocks = [mk('box', [mk('inner')])];
    const next = moveBlock(blocks, 'box', { parentId: 'inner', index: 0 });
    expect(next).toBe(blocks);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/blockTreeMove.test.ts
```

Expected: FAIL 鈥旂涓€涓敤渚嬪緱鍒?`['b','c','a']`锛屼笌鏈熸湜鐨?`['b','a','c']` 涓嶇銆?
- [ ] **Step 3: 鍔犲父閲忓苟淇 moveBlock**

鍦?`apps/web/src/lib/blockTree.ts` 鎶婄 10-11 琛屾浛鎹负锛?
```ts
export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS = 200;
/** 鍗曚釜瀹瑰櫒涓嬬殑鐩存帴瀛愬尯鍧椾笂闄愶紱涓庢繁搴︺€佹€绘暟鏋勬垚鏈」鐩粎鏈夌殑涓夋潯鏍戠害鏉熴€?*/
export const MAX_CHILDREN_PER_CONTAINER = 80;
```

鎶?`moveBlock` 閲?`const without = removeBlock(blocks, id);` 涔嬪悗鐨勫叏閮ㄤ笅鏍囪绠?锛堝師 132-144 琛岋級鏇挎崲涓猴細

```ts
  const without = removeBlock(blocks, id);
  // 鍚屼竴鐖剁骇鍐呭悜涓嬬Щ鍔ㄦ椂锛岀Щ闄ゆ湰鑺傜偣浼氳鐩爣涓嬫爣鍓嶇Щ涓€浣嶏紱缂栬緫鍣ㄧ粰鐨?  // target.index 鏄€屾彃鍒版煇涓€椤逛箣鍚庛€嶏紝鎵€浠ュ厛琛ュ伩锛屽啀澶瑰埌鍚堟硶鑼冨洿銆?  const sameParent = (found.parent?.id ?? null) === (target.parentId ?? null);
  let index = sameParent && found.index < target.index ? target.index - 1 : target.index;
  if (target.parentId) {
    const parent = findBlock(without, target.parentId)?.block;
    if (!parent) return blocks;
    const max = parent.children?.length ?? 0;
    index = Math.min(Math.max(index, 0), max);
  } else {
    index = Math.min(Math.max(index, 0), without.length);
  }
  return insertBlock(without, { ...target, index }, found.block);
```

- [ ] **Step 4: 璺戞祴璇曠‘璁ら€氳繃**

```bash
npx vitest run src/lib/blockTreeMove.test.ts && npx vitest run src/lib/blockTree.test.ts
```

Expected: 涓や釜鏂囦欢鍏ㄩ儴 PASS锛堝惈鏃㈡湁鐨?`blockTree.test.ts`锛岃瘉鏄庢病鏈夊洖褰掞級銆?
- [ ] **Step 5: 鎻愪氦**

```bash
git add apps/web/src/lib/blockTree.ts apps/web/src/lib/blockTreeMove.test.ts
git commit -m "fix(web): compensate the drop index when a block moves down inside one parent"
```

---

