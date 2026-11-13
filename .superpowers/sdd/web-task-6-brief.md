### Task 6: 浣撶Н棰勭畻銆佷繚瀛樻姢鏍忎笌绔埌绔獙璇?
**Files:**
- Modify: `apps/web/src/lib/customize.ts`锛坧rops 浣撶Н銆乣covers` data URL銆佽璁℃€婚噺杞鍛婏級
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`锛堜繚瀛樺墠鐢?`blockBudgetStatus` 鎷︽埅锛?- Modify: `apps/web/src/lib/i18n/*`锛堟柊澧炴枃妗堢殑鑻辨枃锛?- Modify: `apps/web/scripts/e2e-builder-blocks.mjs`
- Test: `apps/web/src/lib/volumeBudget.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: `blockBudgetStatus`锛圱ask 2锛夈€乣normalizeBlockProps`锛圱ask 4锛夈€?- Produces: `PROPS_MAX_BYTES = 8192`銆乣DESIGN_SOFT_LIMIT_BYTES = 524288`銆乣COVER_DATA_URL_MAX = 65536`銆?- Produces: `designVolumeReport(customization): { bytes: number; soft: boolean }`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/volumeBudget.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { COVER_DATA_URL_MAX, PROPS_MAX_BYTES, designVolumeReport } from './customize';

describe('浣撶Н棰勭畻', () => {
  it('灏侀潰 data URL 瓒呰繃 64 KB 琚涪寮?, () => {
    const huge = `data:image/png;base64,${'A'.repeat(COVER_DATA_URL_MAX + 10)}`;
    const report = designVolumeReport({ covers: [{ id: 'c1', url: huge }] });
    expect(report.bytes).toBeLessThan(DESIGN_SOFT_LIMIT_BYTES);
  });

  it('鍗曞潡 props 瓒呰繃 8 KB 鐨勯儴鍒嗕笉鍐嶈鍏?, () => {
    const big = 'x'.repeat(PROPS_MAX_BYTES + 100);
    const report = designVolumeReport({ home: { blocks: [{ id: 'a', type: 'text', props: { body: big } }] } });
    expect(report.bytes).toBeLessThan(PROPS_MAX_BYTES + 1024);
  });

  it('姝ｅ父璁捐涓嶈Е鍙戣蒋璀﹀憡', () => {
    expect(designVolumeReport({ home: { blocks: [] } }).soft).toBe(false);
  });
});
```

锛坄DESIGN_SOFT_LIMIT_BYTES` 浠?`./customize` 涓€骞?import锛屾祴璇曢噷鐢ㄥ埌銆傦級

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/volumeBudget.test.ts
```

Expected: FAIL 鈥斺€?杩欎簺瀵煎嚭杩樹笉瀛樺湪銆?
- [ ] **Step 3: 鍦?customize.ts 瀹炵幇棰勭畻**

鍦?`normalizeMediaUrl` 涔嬪悗鎻掑叆锛?
```ts
/** 鍗曚釜鍖哄潡 props 鐨勫簭鍒楀寲涓婇檺銆?*/
export const PROPS_MAX_BYTES = 8192;
/** 鏁翠唤璁捐鐨勮蒋璀﹀憡绾匡紙纭笂闄愭槸鏈嶅姟绔殑 1 MiB锛夈€?*/
export const DESIGN_SOFT_LIMIT_BYTES = 524288;
/** 灏侀潰鍐呰仈鍥句笂闄愶紱鍐嶅ぇ灏辨槸棣栧睆璐熸媴銆?*/
export const COVER_DATA_URL_MAX = 65536;

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/** 浼扮畻涓€浠借璁＄殑浣撶Н锛屽苟鍒ゆ柇鏄惁瓒婅繃杞鍛婄嚎銆?*/
export function designVolumeReport(customization: unknown): { bytes: number; soft: boolean } {
  const bytes = byteLength(customization);
  return { bytes, soft: bytes > DESIGN_SOFT_LIMIT_BYTES };
}
```

鍦?`normalizeBlockProps` 缁撳熬鍔犱綋绉鍓細

```ts
  const capped: Record<string, BlockPropValue> = {};
  for (const [key, item] of Object.entries(out)) {
    if (byteLength({ [key]: item }) > PROPS_MAX_BYTES) continue;
    capped[key] = item;
  }
  return capped;
```

鎶?`covers` 鐨勫綊涓€鍖栭噷 data URL 鐨勯暱搴︿笂闄愭敼鐢?`COVER_DATA_URL_MAX`锛堝師 1_200_000锛夛紝
骞朵涪寮冭秴闄愰」鑰屼笉鏄埅鏂€?
- [ ] **Step 4: 淇濆瓨鎶ゆ爮**

鍦?`apps/web/src/pages/admin/ThemeBuilder.tsx` 閲岋紝`persistBlocks` 涔嬪墠鍔狅細

```tsx
  const guardBudget = (next: BlockInstance[]): boolean => {
    const total = countBlocks(next);
    if (total <= MAX_BLOCKS) return true;
    toast.error(
      t('杩欎唤缂栨帓鏈?{count} 涓尯鍧楋紝瓒呰繃涓婇檺 {limit} 涓€傝鍏堝垹鎺変竴浜涘啀淇濆瓨銆?, {
        count: total,
        limit: MAX_BLOCKS,
      }),
    );
    return false;
  };
```

`persistBlocks` 绗竴琛屽姞 `if (!guardBudget(next)) return;`锛?import 閲岃ˉ `countBlocks`銆乣MAX_BLOCKS`銆?
- [ ] **Step 5: 琛ヨ嫳鏂囨枃妗?*

鎶婃湰杞柊澧炵殑鎵€鏈?`t()` 鏂囨琛ヨ繘 `apps/web/src/lib/i18n/en.ts`锛堟部鐢ㄦ枃浠跺唴鏃㈡湁鏍煎紡锛?涓枃鍘熸枃浣?key锛夈€傚畬鎴愬悗璺戦椄闂細

```bash
npm run i18n:audit && npx vitest run src/lib/i18n/coverage.test.ts
```

Expected: 瑕嗙洊鐜囦笉浣庝簬鏃㈡湁鍩虹嚎锛宍coverage.test.ts` PASS銆?
- [ ] **Step 6: 鎵╁睍绔埌绔剼鏈?*

鍦?`apps/web/scripts/e2e-builder-blocks.mjs` 鐜版湁鐢ㄤ緥涔嬪悗杩藉姞涓夋鏂█锛?
1. 鎵撳紑椤甸潰缂栨帓 鈫?宸︿晶缁勪欢搴撴嫋鍏ヤ竴涓€屾寜閽€嶏紱
2. 鍦ㄥ彸渚у睘鎬ч潰鏉跨偣銆屾坊鍔犳寜閽€嶄袱娆★紝濉枃瀛椾笌閾炬帴锛屽埛鏂板悗鏂█涓や釜鎸夐挳浠嶅湪锛?3. 鍦ㄥ浘鐗囧潡鐐广€屼粠濯掍綋搴撻€夋嫨銆嶏紝閫夌涓€寮犲浘锛屽埛鏂板悗鏂█ `img[src*="/api/v1/media/"]` 瀛樺湪銆?
```bash
node scripts/e2e-builder-blocks.mjs
```

Expected: 杈撳嚭 `PASS n / FAIL 0`锛屾埅鍥捐惤鍦?`apps/web/.tmp/shots-builder/`銆?
- [ ] **Step 7: 鍏ㄩ噺楠屾敹**

```bash
npm run typecheck && npx vitest run && npm run build
```

Expected: 0 绫诲瀷閿欒銆佸叏閮ㄦ祴璇?PASS銆佹瀯寤烘垚鍔熶笖 dist 澧為噺涓嶈秴杩?40 KB銆?
- [ ] **Step 8: 鎻愪氦**

```bash
git add apps/web/src/lib/customize.ts apps/web/src/pages/admin/ThemeBuilder.tsx \
  apps/web/src/lib/i18n apps/web/src/lib/volumeBudget.test.ts apps/web/scripts/e2e-builder-blocks.mjs
git commit -m "feat(web): enforce design volume budgets and guard saves at the block limit"
```

---

