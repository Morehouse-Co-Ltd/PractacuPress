### Task 2: 鏈煡鍖哄潡淇濈暀 + 鏍圭骇 24 涓婇檺鍒犻櫎

`normalizeBlock` 瀵逛笉璁よ瘑鐨?`type` 鐩存帴杩斿洖 `null`锛坄customize.ts:557`锛夛紝鑰?hydration 鎶婂綊涓€鍖?缁撴灉鍐欏洖 localStorage銆佷笅娆′繚瀛樺張 PUT 鍥炲幓鈥斺€?*浠庢洿鏂扮増鏈鍏ョ殑鍖哄潡浼氭案涔呮秷澶?*銆?鍚屾椂鏍圭骇 `.slice(0, 24)`锛坄customize.ts:611`锛夎绗?25 涓尯鍧楀嚟绌烘秷澶便€?
**Files:**
- Modify: `apps/web/src/types.ts`锛坄BlockInstance` 鍔?`unsupported?: boolean`锛?- Modify: `apps/web/src/lib/customize.ts:548-641`
- Test: `apps/web/src/lib/customizeBlocks.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: `MAX_CHILDREN_PER_CONTAINER`銆乣MAX_BLOCKS`锛圱ask 1锛夈€?- Produces: `export function normalizeScreenLayout(value: unknown): ScreenLayout`鈥斺€?  鍘熸湰妯″潡绉佹湁鐨?`normalizeLayout` 鏀逛负瀵煎嚭锛屼緵缂栬緫鍣ㄤ笌娴嬭瘯鐩存帴璋冪敤銆?- Produces: `export function blockBudgetStatus(layout: ScreenLayout): { total: number; limit: number; over: boolean }`鈥斺€?  缂栬緫鍣ㄤ繚瀛樺墠鐢ㄥ畠鍒ゆ柇鏄惁瓒呴檺銆?- Produces: `BlockInstance.unsupported?: boolean`鈥斺€擿true` 琛ㄧず绫诲瀷鏉ヨ嚜鏇存柊鐗堟湰锛屼繚鐣欎絾涓嶆覆鏌撱€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/customizeBlocks.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { blockBudgetStatus, normalizeScreenLayout } from './customize';

function textBlock(id: string) {
  return { id, type: 'text', title: id, props: { body: 'hi' }, animation: 'none', hidden: false };
}

describe('normalizeScreenLayout', () => {
  it('淇濈暀涓嶈璇嗙殑鍖哄潡绫诲瀷骞舵墦涓?unsupported', () => {
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'x1', type: 'pricing-v9', title: '浠锋牸', props: { plan: 'A' } }],
    });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0].type).toBe('pricing-v9');
    expect(layout.blocks[0].unsupported).toBe(true);
    expect(layout.blocks[0].props).toEqual({ plan: 'A' });
  });

  it('鏍圭骇涓嶅啀鎴柇鍒?24 涓?, () => {
    const blocks = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`));
    const layout = normalizeScreenLayout({ blocks });
    expect(layout.blocks).toHaveLength(30);
  });

  it('瀹瑰櫒瀛愬尯鍧椾粛鍙?80 鏉′笂闄愮害鏉?, () => {
    const children = Array.from({ length: 90 }, (_, i) => textBlock(`c${i}`));
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'box', type: 'container', title: 'box', props: {}, animation: 'none', hidden: false, children }],
    });
    expect(layout.blocks[0].children).toHaveLength(80);
  });

  it('娌℃湁浠讳綍 type 鐨勬潯鐩洿鎺ヤ涪寮?, () => {
    const layout = normalizeScreenLayout({ blocks: [{ id: 'bad' }, textBlock('ok')] });
    expect(layout.blocks.map((block) => block.id)).toEqual(['ok']);
  });
});

describe('blockBudgetStatus', () => {
  it('瓒呰繃 200 涓尯鍧楁椂鎶ュ憡瓒呴檺', () => {
    const blocks = Array.from({ length: 201 }, (_, i) => textBlock(`b${i}`));
    const status = blockBudgetStatus({ blocks });
    expect(status.over).toBe(true);
    expect(status.limit).toBe(200);
  });

  it('姝ｅ父缂栨帓涓嶈秴闄?, () => {
    expect(blockBudgetStatus({ blocks: [textBlock('a')] }).over).toBe(false);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/customizeBlocks.test.ts
```

Expected: FAIL 鈥斺€?`blockBudgetStatus` 涓嶆槸瀵煎嚭鎴愬憳锛涙湭鐭ョ被鍨嬮偅鏉℃柇瑷€鎷垮埌 0 涓尯鍧椼€?
- [ ] **Step 3: 鍦?types.ts 缁?BlockInstance 鍔犲瓧娈?*

鍦?`apps/web/src/types.ts` 鐨?`BlockInstance` 閲岋紝`appearance?: BlockAppearance;` 涔嬪悗杩藉姞锛?
```ts
  /**
   * 褰掍竴鍖栨椂鏃犳硶璇嗗埆鐨勫尯鍧楃被鍨嬶細淇濈暀鍘熸牱銆佷笉娓叉煋銆佷繚瀛樻椂鍐欏洖銆?   * 杩欐牱浠庢洿鏂扮増鏈鍑虹殑璁捐涓嶄細鍥犱负鏈増鏈笉璁よ瘑鑰屽湪涓嬩竴娆′繚瀛樻椂姘镐箙娑堝け銆?   */
  unsupported?: boolean;
```

- [ ] **Step 4: 鏀?normalizeBlock 涓?normalizeBlockList**

鍦?`apps/web/src/lib/customize.ts`锛屾妸 `normalizeBlock` 閲岃繖涓よ锛?
```ts
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;
  budget.count += 1;
```

鏇挎崲涓猴細

```ts
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !raw.type) return null;
  budget.count += 1;
  const known = BLOCK_TYPES.has(raw.type);
```

鎺ョ潃鎶婂瓙鍖哄潡閭ｈ鐨?`.slice(0, 80)` 鎹㈡垚甯搁噺锛?
```ts
  const children = Array.isArray(raw.children)
    ? raw.children
        .slice(0, MAX_CHILDREN_PER_CONTAINER)
        .map((child) => normalizeBlock(child, depth + 1, seen, budget))
        .filter((child): child is BlockInstance => !!child)
    : [];
```

鍐嶅湪 `const appearance = normalizeBlockAppearance(raw.appearance);` 涔嬪墠鎻掑叆鏈煡绫诲瀷鍒嗘敮锛?
```ts
  if (!known) {
    // 涓嶈璇嗙殑绫诲瀷锛氫繚鐣欏舰鐘讹紝涓嶈В閲?props锛屾覆鏌撳櫒浼氳烦杩囧畠銆?    const unsupportedProps: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(raw.props ?? {})) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        unsupportedProps[key] = item;
      }
    }
    return {
      id,
      type: raw.type.slice(0, 64),
      title: text(raw.title, '', 80) || raw.type.slice(0, 64),
      props: unsupportedProps,
      animation: animation(raw.animation),
      hidden: bool(raw.hidden, false),
      unsupported: true,
      ...(children.length ? { children } : {}),
    };
  }
```

鐒跺悗鍦?`normalizeBlockList` 閲屽幓鎺夋牴绾?24 鏉℃埅鏂細

```ts
  const blocks = raw
    .map((block) => normalizeBlock(block))
    .filter((block): block is BlockInstance => !!block);
```

鍦ㄦ枃浠堕噷 `normalizeLayout` 涔嬪悗杩藉姞瀵煎嚭涓庨绠楀嚱鏁帮紙鍚屾椂鎶?`normalizeLayout` 鏀瑰悕骞跺鍑猴級锛?
```ts
export function normalizeScreenLayout(value: unknown): ScreenLayout {
  return normalizeLayout(value);
}

/** 缂栨帓鐨勫尯鍧楁€婚噺锛涚紪杈戝櫒淇濆瓨鍓嶇敤瀹冩尅浣忚秴闄愶紝鑰屼笉鏄褰掍竴鍖栭潤榛樻埅鏂€?*/
export function blockBudgetStatus(layout: ScreenLayout): {
  total: number;
  limit: number;
  over: boolean;
} {
  const perDevice = Object.values(layout.devices ?? {}).map((entry) =>
    countBlocks((entry as { blocks: BlockInstance[] }).blocks),
  );
  const total = Math.max(countBlocks(layout.blocks), 0, ...perDevice);
  return { total, limit: MAX_BLOCKS, over: total > MAX_BLOCKS };
}
```

纭鏂囦欢椤堕儴宸蹭粠 `./blockTree` 寮曞叆 `countBlocks`锛涜嫢娌℃湁锛岃ˉ杩涙棦鏈夌殑 import 璇彞銆?
- [ ] **Step 5: 璺戞祴璇曠‘璁ら€氳繃**

```bash
npx vitest run src/lib/customizeBlocks.test.ts && npx vitest run
```

Expected: 鏂版枃浠跺叏 PASS锛屾暣浠撴祴璇曚粛鐒跺叏缁裤€?
- [ ] **Step 6: 鎻愪氦**

```bash
git add apps/web/src/types.ts apps/web/src/lib/customize.ts apps/web/src/lib/customizeBlocks.test.ts
git commit -m "fix(web): keep unknown block types and drop the silent root-level cap"
```

---

