### Task 4: 璇存湇缁勪欢鍥涗欢濂楋紙瀹氫环 / FAQ / 璇佽█ / 鍥炬枃浜ゆ浛锛?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/ConversionBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/conversionBlocks.test.ts`锛堟柊寤猴級

| type | 涓枃鍚?| defaults | schema 瑕佺偣 |
| --- | --- | --- | --- |
| `pricing` | 瀹氫环琛?| `heading:'', items:[]` | `items` repeater锛坄name`銆乣price`銆乣period`銆乣features` textarea锛堟崲琛屽垎闅旓級銆乣cta_label`銆乣cta_link`銆乣featured` toggle锛夋渶澶?4 鏉?|
| `faq` | 甯歌闂 | `heading:'', open_first:false, items:[]` | `items` repeater锛坄question`銆乣answer` textarea锛夋渶澶?20 鏉?|
| `testimonial` | 鐢ㄦ埛璇勪环 | `heading:'', layout:'grid', items:[]` | `layout` select grid/carousel锛沗items` repeater锛坄quote` textarea銆乣name`銆乣role`銆乣avatar` media锛夋渶澶?9 鏉?|
| `media-text` | 鍥炬枃浜ゆ浛 | `image:'', alt:'', title:'', body:'', side:'left', cta_label:'', cta_link:''` | `image` media銆乣alt` text銆乣title` text銆乣body` richtext锛圱ask 1锛夈€乣side` select left/right銆乣cta_*` |

**娓叉煋瑕佹眰**
- `pricing`锛氭帹鑽愭。锛坄featured`锛夊姞涓婚鑹叉弿杈逛笌銆屾帹鑽愩€嶈鏍囷紱`features` 鎸夋崲琛屾媶鎴愬垪琛ㄩ」锛?  浠?`-` 寮€澶磋涓?涓嶅惈"锛堢伆鑹插垹闄ょ嚎锛夈€備环鏍间笌鍛ㄦ湡鍋氳瑙変富娆°€?- `faq`锛氬師鐢?`<details>`锛宍open_first` 鍙奖鍝嶇涓€鏉★紱闂鐢?`<summary>`锛堥敭鐩樺彲杈撅級銆?- `testimonial`锛歚carousel` 鐢?CSS `scroll-snap` 妯粦锛堥浂 JS锛夛紝鍔犲垎椤靛渾鐐癸紙绾?CSS 鍋氫笉鍒板氨鐪佺暐鍦嗙偣锛?  鍦ㄦ姤鍛婇噷璇存槑锛夈€?- `media-text`锛歚side` 鎺у埗鍥惧湪宸﹁繕鏄彸锛岀獎灞忎竴寰嬪浘鍦ㄤ笂銆佹枃鍦ㄤ笅锛沗body` 璧?Markdown 娓叉煋閾捐矾銆?- 鎵€鏈夐摼鎺ヨ蛋鏃㈡湁 URL 鐧藉悕鍗曪紙`safeUrl`锛夛紝澶栭摼琛?`rel="noreferrer noopener"`銆?
**娴嬭瘯**锛氬洓鏉″畾涔?defaults 鈯?schema锛沗features` 鎹㈣鎷嗗垎鐨勭函鍑芥暟 `splitFeatures(text)` 鍗曟祴
锛堝惈浠?`-` 寮€澶淬€佺┖琛屻€佸幓閲嶏級锛涙覆鏌撳櫒宸叉敞鍐屻€?
Commit: `git commit -m "feat(web): add the pricing, FAQ, testimonial and media-text blocks"`

---

