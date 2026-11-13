### Task 3: 濯掍綋缁勪欢涓変欢濂楋紙鍥㈤槦 / Logo 澧?/ 鍥鹃泦锛?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/MediaGalleryBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/mediaGalleryBlocks.test.ts`锛堟柊寤猴級

| type | 涓枃鍚?| defaults | schema 瑕佺偣 |
| --- | --- | --- | --- |
| `team` | 鍥㈤槦鎴愬憳 | `heading:'', columns:3, items:[]` | `items` repeater锛坄avatar` media銆乣name` text銆乣role` text銆乣link` text锛夋渶澶?12 鏉?|
| `logo-wall` | Logo 澧?| `heading:'', columns:4, items:[]` | `items` repeater锛坄image` media銆乣link` text銆乣alt` text锛夋渶澶?12 鏉?|
| `gallery` | 鍥鹃泦 | `heading:'', columns:3, ratio:'4:3', items:[]` | `ratio` select 1:1 / 4:3 / 16:9锛沗items` repeater锛坄image` media銆乣caption` text锛夋渶澶?20 鏉?|

**娓叉煋瑕佹眰**
- `team`锛氬ご鍍忓渾褰紙`border-radius: 50%`锛夛紝缂哄浘鏃剁敤濮撳悕棣栧瓧姣嶅仛鍗犱綅锛堜富棰樿壊搴曪級锛屼笉鍑虹幇鐮村浘鍥炬爣銆?- `logo-wall`锛氱伆搴︽樉绀恒€乭over 鎭㈠褰╄壊锛沗filter: grayscale(1)`锛宍prefers-reduced-motion` 涓嬩笉鍋氳繃娓°€?- `gallery`锛氭爡鏍?+ 鍘熺敓 `<dialog>` 鐏銆傜偣缂╃暐鍥炬墦寮€澶у浘锛宍Esc` 鍏抽棴锛屽叧闂悗鐒︾偣鍥炲埌琚偣鐨勭缉鐣ュ浘
  锛坄dialog.close()` 鍚?`.focus()`锛夈€傜伅绠遍噷鍙互宸﹀彸鍒囨崲锛堜笂涓€寮?涓嬩竴寮犳寜閽?+ 宸﹀彸鏂瑰悜閿級銆?- 鎵€鏈?`<img>` 蹇呴』鏈?`alt`锛坄logo-wall` 鐢ㄦ潯鐩噷鐨?`alt`锛岀己鐪佺敤 `#`? 涓嶈鈥斺€旂己鐪佺┖涓?`alt=""` 琛ㄧず瑁呴グ鍥撅級銆?
**娴嬭瘯**锛氫笁鏉″畾涔夊瓨鍦ㄤ笖 defaults 鈯?schema锛涙覆鏌撳櫒宸叉敞鍐岋紱`gallery` 鐨勭伅绠辩姸鎬佹満
锛堟墦寮€/鍏抽棴/鍓嶅悗鍒囨崲鐨勫綋鍓嶄笅鏍囪绠楋級鎶芥垚绾嚱鏁?`lightboxStep(current, delta, total)` 骞跺崟娴嬨€?
Commit: `git commit -m "feat(web): add the team, logo wall and gallery blocks"`

---

