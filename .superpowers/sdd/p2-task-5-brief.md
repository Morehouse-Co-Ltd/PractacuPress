### Task 5: 鍓╀綑涓変釜 + 鏀跺彛锛堝姣旇〃 / 鍊掕鏃?/ 闊抽锛?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/UtilityBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/scripts/e2e-builder-blocks.mjs`
- Test: `apps/web/src/lib/utilityBlocks.test.ts`锛堟柊寤猴級

| type | 涓枃鍚?| defaults | schema 瑕佺偣 |
| --- | --- | --- | --- |
| `comparison` | 瀵规瘮琛?| `heading:'', left_label:'', right_label:'', rows:[]` | `rows` repeater锛坄label`銆乣left`銆乣right`锛夋渶澶?12 鏉?|
| `countdown` | 鍊掕鏃?| `title:'', target:'', expired_text:'', show_seconds:true` | `target` 鏃ユ湡鏂囨湰锛坄YYYY-MM-DD` 鎴?ISO锛夛紱`show_seconds` toggle |
| `audio` | 闊抽 | `src:'', title:'', artist:'', cover:''` | `src`/`cover` media銆乣title`/`artist` text |

**娓叉煋瑕佹眰**
- `comparison`锛氳〃鏍艰涔夛紙`<table>` + `<th scope>`锛夛紝绐勫睆鍙í鍚戞粴鍔紝涓嶅鎴愮函鏂囨湰銆?- `countdown`锛歚useEffect` 璧?1s 瀹氭椂鍣紝鍗歌浇蹇呴』娓呯悊锛涘€掕鏃剁粨鏉熸樉绀?`expired_text`锛?  鏈嶅姟绔覆鏌撴棤鍏筹紙鏈」鐩函瀹㈡埛绔級锛屼絾瑕侀伩鍏嶉甯ч棯 `NaN`鈥斺€斿垵濮嬬姸鎬佹樉绀哄崰浣嶃€?- `audio`锛氬師鐢?`<audio controls>`锛宍preload="metadata"`锛?*涓嶈嚜鍔ㄦ挱鏀?*銆?
**鏀跺彛**锛堟湰浠诲姟鏈€鍚庝竴姝ワ紝蹇呭仛锛夛細
1. `npx vitest run` 鍏ㄧ豢锛?2. `npm run typecheck`銆乣npm run build` 閫氳繃锛屽苟璁板綍 gzip 澧為噺锛堝姣?P1 鏀跺熬鐨勬瀯寤轰骇鐗╋紝鈮?25 KB锛夛紱
3. `node scripts/e2e-builder-blocks.mjs` 璺戦€氾紙PASS 鏁?鈮?涔嬪墠鐨?37锛夛紝鎴浘钀?`.tmp/shots-builder/`锛?4. 鍦?`docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` 杩藉姞 搂14銆孭2 瀹炵幇璁板綍銆嶏細
   缁勪欢娓呭崟銆侀獙璇佹暟瀛椼€佷綋绉閲忋€佹湭鍋氱殑锛坄anchor-nav` 椤哄欢 P3锛変笌宸茬煡鍙栬垗銆?
Commit: `git commit -m "feat(web): add the comparison, countdown and audio blocks"`

---

