### Task 2: `content-query` 鏌ヨ鍧?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛堟敞鍐?`content-query`锛?- Create: `apps/web/src/components/blocks/QueryBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/lib/api.ts`锛坄listContent` 閫忎紶鏂板弬鏁帮級
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/queryBlock.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: Task 1 鐨勫洓涓弬鏁帮紱`FeedContext`銆乣useTaxonomy`銆乣blockPropRecord`銆?- Produces: `queryRequest(block): { categoryId?, tag?, since?, sort, limit, layout }`鈥斺€旂函鍑芥暟锛?  鎶婂尯鍧?props 缈昏瘧鎴愯姹傚弬鏁帮紱绌哄€间笉鍑虹幇锛堣€屼笉鏄紶绌轰覆锛夈€?- Produces: `sinceFromWindow(window: string, now: Date): string | undefined`鈥斺€擿7d`/`30d`/`all`
  鈫?RFC3339锛沗all` 杩斿洖 `undefined`銆?
| props | 绫诲瀷 | 璇存槑 |
| --- | --- | --- |
| `source` | select `latest` / `category` / `tag` / `author` | 閫夊悗涓や釜鏃舵墠鍚敤瀵瑰簲绛涢€?|
| `term_id` | text | 鍒嗙被鎴栨爣绛剧殑 id/鍚嶇О |
| `window` | select `all` / `7d` / `30d` | |
| `sort` | select `newest` / `oldest` | |
| `layout` | select `list` / `grid` | 澶嶇敤鏃㈡湁鍗＄墖鏍峰紡 |
| `limit` | number 1鈥?4 | |
| `show_excerpt` / `show_meta` | toggle | |

**娓叉煋瑕佹眰**
- 鍙栨暟璧?`api.listContent`锛堢湡瀹炲悗绔級涓庢紨绀烘暟鎹紙demo 妯″紡锛変袱鏉℃棦鏈夎矾寰勶紱
  婕旂ず妯″紡娌℃湁鏈嶅姟绔瓫閫夛紝**缂栬緫鍣ㄩ噷鎶?`source`/`window`/`sort` 涔嬪鐨勬潯浠舵爣娉ㄤ负"婕旂ず妯″紡涓嶇敓鏁?**銆?- 绌虹粨鏋滄覆鏌撲竴鍙?`t('杩欓噷杩樻病鏈夊唴瀹广€?)`锛屼笉娓叉煋绌哄鍣ㄣ€?- 楠ㄦ灦锛氬湪 `lib/loading.ts` 鐨?`BLOCK_SKELETON_SHAPES` 閲岀粰瀹冪櫥璁颁竴涓舰鐘讹紙瀹冧緷璧?feed 鏁版嵁锛夈€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// apps/web/src/lib/queryBlock.test.ts
import { describe, expect, it } from 'vitest';
import { queryRequest, sinceFromWindow } from './blocks';

describe('sinceFromWindow', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  it('all 涓嶅甫鏃堕棿鏉′欢', () => {
    expect(sinceFromWindow('all', now)).toBeUndefined();
  });
  it('7d / 30d 鎹㈢畻鎴?RFC3339', () => {
    expect(sinceFromWindow('7d', now)).toBe('2026-10-27T00:00:00.000Z');
    expect(sinceFromWindow('30d', now)).toBe('2026-10-04T00:00:00.000Z');
  });
  it('鍧忓€煎洖钀藉埌涓嶅甫鏉′欢', () => {
    expect(sinceFromWindow('nope', now)).toBeUndefined();
  });
});

describe('queryRequest', () => {
  it('latest 涓嶅甫鍒嗙被涓庢爣绛?, () => {
    const req = queryRequest({ source: 'latest', limit: 6, sort: 'newest' } as never);
    expect(req.categoryId).toBeUndefined();
    expect(req.tag).toBeUndefined();
    expect(req.limit).toBe(6);
  });
  it('category 婧愬甫涓?term_id', () => {
    const req = queryRequest({ source: 'category', term_id: 'cat-1', limit: 3 } as never);
    expect(req.categoryId).toBe('cat-1');
  });
  it('绌?term_id 涓嶄骇鐢熺┖涓叉潯浠?, () => {
    const req = queryRequest({ source: 'category', term_id: '', limit: 3 } as never);
    expect(req.categoryId).toBeUndefined();
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?* 鈫?`npx vitest run src/lib/queryBlock.test.ts`

- [ ] **Step 3: 瀹炵幇**锛堟敞鍐岃〃鏉＄洰 + 涓や釜绾嚱鏁?+ 娓叉煋鍣?+ 鏍峰紡 + 楠ㄦ灦鐧昏锛?
- [ ] **Step 4: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck && npm run build
git commit -m "feat(web): add the content query block"
```

---

