### Task 3: 閿氱偣涓庣洰褰?
**Files:**
- Modify: `apps/web/src/components/builder/BlockInspector.tsx`锛堥敋鐐硅緭鍏ワ級
- Modify: `apps/web/src/lib/blocks.ts`锛堟敞鍐?`anchor-nav`锛?- Create: `apps/web/src/components/blocks/AnchorNav.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`銆乣apps/web/src/styles.css`
- Test: `apps/web/src/lib/anchorNav.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: `BlockInstance.anchor`锛圥0 寤烘ā銆丳1 淇濈暀锛夈€?- Produces: `normalizeAnchor(raw: string): string`鈥斺€斿皬鍐欍€佺┖鏍艰浆 `-`銆佸彧鐣?`[a-z0-9-]`銆佲墹 40 瀛楃銆?- Produces: `anchorTargets(blocks: BlockInstance[]): { anchor: string; title: string }[]`鈥斺€旈€掑綊鏀堕泦鍚岄〉鏈夐敋鐐圭殑鍖哄潡锛堜繚鎸佹枃妗ｉ『搴忥級锛屼緵鐩綍娓叉煋涓庢祴璇曞叡鐢ㄣ€?
**娓叉煋瑕佹眰**
- 鐩綍娓叉煋鎴?`<nav aria-label="鏈〉鐩綍">` + 涓€缁?`<a href="#anchor">`銆?- 婊氬姩楂樹寒鐢?`IntersectionObserver`锛堥槇鍊?0.25锛夛紝鍗歌浇鏃?`disconnect()`锛?  娌℃湁 `IntersectionObserver` 鐨勭幆澧冮€€鍖栦负涓嶉珮浜紙涓嶅奖鍝嶈烦杞級銆?- 閿氱偣涓虹┖鎴栭噸澶嶆椂锛氬尯鍧椾晶蹇界暐锛岀洰褰曚晶鍘婚噸锛堢涓€娆″嚭鐜拌€呰儨锛夈€?- 鐐瑰嚮鏄師鐢熼敋鐐硅烦杞紝涓嶈皟 `scrollIntoView`鈥斺€斾繚鎸佸彲澶嶅埗 URL銆佸彲鐢ㄦ祻瑙堝櫒鍓嶈繘鍚庨€€銆?- 骞虫粦婊氬姩浜ょ粰 CSS锛歚html { scroll-behavior: smooth }`锛屽苟鍦?`prefers-reduced-motion` 涓嬪叧鎺?  锛堟鏌?`styles.css` 鏄惁宸叉湁杩欐潯锛屾湁灏卞鐢紝鍒啓绗簩浠斤級銆?
- [ ] **Step 1鈥?**锛氬厛鍐?`anchorNav.test.ts`锛坄normalizeAnchor` 鐨勫綊涓€鍖栦笌鎴柇銆乣anchorTargets` 鐨?  閫掑綊鏀堕泦涓庡幓閲嶏級锛屽啀瀹炵幇锛屽啀璺戝叏閲忋€?  `BlockInspector` 閲屽姞涓€涓€岄敋鐐广€嶆枃鏈緭鍏ワ紝鍐欏叆璧版棦鏈夌殑 `patch`锛堥敋鐐逛笉灞炰簬灞曠ず灞傦紝涓嶈繘 `at`锛夈€?
Commit: `git commit -m "feat(web): add block anchors and the table of contents block"`

---

