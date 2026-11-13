### Task 4: 鑱旂郴琛ㄥ崟

**鑼冨洿鍐冲畾锛堝啓杩涙姤鍛婏級**锛氬彧鍋?*鑱旂郴琛ㄥ崟**锛屽鐢ㄦ棦鏈夐€氱煡閾捐矾鈥斺€旀彁浜ゅ嵆缁欑珯鐐圭鐞嗗憳鍙戜竴鏉￠€氱煡锛?涓嶆柊寤鸿〃銆佷笉鍋氳闃呭悕鍗曘€傜悊鐢憋細璁㈤槄鍚嶅崟闇€瑕佽闃呰€呰〃銆侀€€璁€佸鍑轰笌鍚堣澹版槑锛屾槸鐙珛璁锛?鑰?璇昏€呰兘缁欑珯闀跨暀涓€鍙ヨ瘽"鐢ㄩ€氱煡灏辫兘闂幆锛屼笖娌℃湁浠讳綍鏁版嵁鐣欏瓨椋庨櫓銆?
**Files:**
- Modify: `apps/api/internal/notifications/*`锛堟柊澧炰竴涓唴閮ㄦ姇閫掑叆鍙ｏ紝鎴栧鐢ㄦ棦鏈夊垱寤洪€氱煡鐨勬湇鍔★級
- Create: `apps/api/internal/site/contact.go` + `contact_test.go`
- Modify: `apps/api/internal/site/handler.go`锛堟寕 `POST /sites/{siteID}/contact`锛?- Modify: `packages/contracts/openapi/openapi.yaml`
- Modify: `apps/web/src/lib/blocks.ts`锛堟敞鍐?`contact-form`锛?- Create: `apps/web/src/components/blocks/FormBlocks.tsx`
- Test: `apps/web/src/lib/contactForm.test.ts`锛堟柊寤猴級

**鎺ュ彛**
- `POST /sites/{siteID}/contact`锛屽尶鍚嶅瓧娈碉細`name`锛堚墹80锛夈€乣email`锛堚墹200锛屽繀椤诲惈 `@`锛夈€?  `message`锛堚墹2000锛夈€傛垚鍔?202锛屽け璐?400銆?- **鍙嶆互鐢?*锛氳蛋寮曟搸鏃㈡湁鐨勫叏灞€闄愭祦锛涘啀鍔犱竴涓?honeypot 瀛楁 `website`锛堥潪绌哄嵆闈欓粯杩斿洖 202 浣嗕笉鎶曢€掞級
  涓庢彁浜ら棿闅旈檺鍒讹紙鍚屼竴浼氳瘽 60 绉掍竴娆★紝鍓嶇涓庢湇鍔＄鍚勪竴灞傦級銆?- 閫氱煡姝ｆ枃鍙瓨绾枃鏈紝涓婚褰㈠ `绔欑偣鏉ヤ俊锛?name>`锛涗笉鎶婄敤鎴疯緭鍏ユ嫾杩?HTML銆?
**鍓嶇**
- `contact-form` 鍖哄潡锛歚heading` / `intro`锛坮ichtext锛? `submit_label` / `success_text` /
  `show_email` / `show_name`锛坱oggle锛夈€?- 鎻愪氦鎬佷笁鎬侊細idle / sending / sent锛屽け璐ユ樉绀?`t('鍙戦€佸け璐ワ紝璇风◢鍚庡啀璇曘€?)`锛屾案杩滀笉娓呯┖鐢ㄦ埛杈撳叆銆?- 婕旂ず妯″紡锛氫笉鍙戣姹傦紝鐩存帴杩涘叆鎴愬姛鎬侊紝骞跺湪鎸夐挳涓嬫柟鏍囨敞 `t('婕旂ず妯″紡涓嬩笉浼氱湡鐨勫彂閫併€?)`銆?
**娴嬭瘯**
- Go锛歚contact_test.go` 瑕嗙洊鍚堟硶鎻愪氦 鈫?202 涓旀姇閫掍竴娆★紱`message` 瓒呴暱 鈫?400锛沨oneypot 闈炵┖ 鈫?  202 涓斾笉鎶曢€掞紱60 绉掑唴浜屾鎻愪氦 鈫?429銆?- 鍓嶇锛歚contactForm.test.ts` 瑕嗙洊瀛楁鏍￠獙锛堢┖娑堟伅銆侀潪娉?email锛変笌 honeypot 瑙﹀彂鏃朵笉璋冪敤 API銆?
Commit: `git commit -m "feat: add the contact form block and its endpoint"`

---

