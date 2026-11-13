### Task 1: `richtext` 灞炴€х被鍨?
P2 閲屻€屽浘鏂囦氦鏇裤€嶇殑姝ｆ枃闇€瑕佹钀界骇瀵屾枃鏈紱`text` 鍖哄潡鐨?Markdown 娓叉煋閾捐矾宸茬粡瀛樺湪锛岃繖閲屽彧鏄妸
瀹冨彉鎴愪竴绉嶅彲澶嶇敤鐨勫睘鎬х被鍨嬨€?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛坄PropType` 鍔?`'richtext'`锛?- Modify: `apps/web/src/components/builder/BlockProps.tsx`锛坮ichext 鎺т欢锛?- Modify: `apps/web/src/lib/customize.ts`锛坄richtext` 鍊兼寜 Markdown 鏂囨湰娓呮礂锛氶暱搴︿笂闄?8000锛岃蛋鏃㈡湁 `scalarValue`锛?- Test: `apps/web/src/lib/richtextProp.test.ts`锛堟柊寤猴級

**Interfaces:**
- Produces: `PropType` 澧炲姞 `'richtext'`锛涘€煎氨鏄?Markdown 瀛楃涓层€?- Produces: 琛ㄥ崟鎺т欢 = 涓€涓?`Textarea`锛堟渶灏忛珮 140px锛? 銆岄瑙堛€嶆姌鍙犲尯锛堢敤 `dangerouslySetInnerHTML` 娓叉煋 `sanitizeHtml(renderMarkdown(value))`锛屼笌 `text` 鍖哄潡鍚屼竴濂楀嚱鏁帮級銆?- Consumes: `apps/web/src/lib/markdown.ts` 鐨?`renderMarkdown`銆乣apps/web/src/lib/markdown.ts` 鎴栧悓鐩綍鐨?`sanitizeHtml`锛堣浠ｇ爜纭鐪熷疄瀵煎嚭鍚嶏級銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// apps/web/src/lib/richtextProp.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeBlockProps } from './customize';
import { BLOCK_DEFS } from './blocks';

describe('richtext 灞炴€?, () => {
  it('浣滀负 Markdown 瀛楃涓蹭繚瀛橈紝瓒呴暱琚埅鏂?, () => {
    const long = '# 鏍囬\n\n' + '娈佃惤銆?.repeat(3000);
    const props = normalizeBlockProps('media-text', { body: long });
    expect(typeof props.body).toBe('string');
    expect((props.body as string).length).toBeLessThanOrEqual(8000);
  });

  it('闈炲瓧绗︿覆琚涪寮?, () => {
    expect(normalizeBlockProps('media-text', { body: 42 }).body).toBeUndefined();
  });

  it('鑷冲皯鏈変竴涓尯鍧楀０鏄庝簡 richtext 灞炴€?, () => {
    const types = BLOCK_DEFS.flatMap((def) => def.schema.map((field) => field.type));
    expect(types).toContain('richtext');
  });
});
```

锛坄media-text` 鏄?Task 4 鎵嶄細鍔犵殑鍖哄潡锛涙湰浠诲姟鍏堣 `text` 鍖哄潡鐨?`body` 椤烘墜鍗囩骇鎴?`richtext`
浠ヤ究娴嬭瘯鏈夊璞♀€斺€旇嫢鏀瑰姩 `text` 浼氬奖鍝嶆棦鏈夐厤缃粨鏋勶紙瀹冧粛鏄?Markdown 瀛楃涓诧紝鎵€浠ヤ笉浼氾級锛?灏卞湪鎶ュ憡閲岃鏄庛€傦級

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/richtextProp.test.ts
```

Expected: FAIL 鈥斺€?`PropType` 閲屾病鏈?`richtext`锛屾渶鍚庝竴涓柇瑷€澶辫触銆?
- [ ] **Step 3: 瀹炵幇**

- `blocks.ts` 鐨?`PropType` 鍔?`| 'richtext'`锛屾敞閲婂啓鏄庛€孧arkdown 瀛楃涓诧紝娓叉煋鍓嶈繃 sanitizeHtml銆嶃€?- `BlockProps.tsx` 鍔?`richtext` 鍒嗘敮锛歚Textarea` + 鍙€夐瑙堛€?- `customize.ts`锛歚richtext` 涓?`textarea` 鍚岃矾寰勬竻娲楋紝浣嗛暱搴︿笂闄?8000锛坄scalarValue` 鐜板湪缁熶竴 4000锛?  缁?richtext 鍗曠嫭涓€鏉″垎鏀級銆?
- [ ] **Step 4: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck && npm run i18n:audit
git add apps/web/src/lib/blocks.ts apps/web/src/components/builder/BlockProps.tsx apps/web/src/lib/customize.ts apps/web/src/lib/richtextProp.test.ts
git commit -m "feat(web): add the richtext property type"
```

---

