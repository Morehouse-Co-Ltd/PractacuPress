### Task 2: 鏃犲獟浣撶粍浠朵笁浠跺锛堝姛鑳界綉鏍?/ 鍗＄墖缁?/ 姝ラ锛?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛堜笁鏉℃敞鍐岃〃瀹氫箟锛?- Create: `apps/web/src/components/blocks/MarketingBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`锛堟敞鍐屾覆鏌撳櫒锛?- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/marketingBlocks.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: `PropSchema` 鐨?`repeater`銆乣blockPropRecord(block, key)`銆乣blockProp(block, key, fallback)`銆?- Produces: `MARKETING_RENDERERS: Record<string, (props: { block }) => ReactElement | null>`锛?  鍦?`components/blocks/index.tsx` 鐨?`RENDERERS` 閲屽睍寮€銆?
涓夋潯瀹氫箟锛坄group: 'content'`锛宍variants: ['classic', 'bento']`锛夛細

| type | 涓枃鍚?| defaults | schema 瑕佺偣 |
| --- | --- | --- | --- |
| `feature-grid` | 鍔熻兘缃戞牸 | `heading:'', columns:3, items:[]` | `heading` text锛沗columns` select 2/3/4锛沗items` repeater锛坄icon` text銆乣title` text銆乣text` textarea锛夋渶澶?8 鏉?|
| `card-grid` | 鍗＄墖缁?| `heading:'', columns:3, items:[]` | `heading` text锛沗columns` select 2/3/4锛沗items` repeater锛坄title` text銆乣text` textarea銆乣link` text锛夋渶澶?9 鏉?|
| `steps` | 姝ラ | `heading:'', orientation:'vertical', items:[]` | `heading` text锛沗orientation` select vertical/horizontal锛沗items` repeater锛坄title` text銆乣text` textarea锛夋渶澶?8 鏉?|

**娓叉煋瑕佹眰**
- 绌?`items` 鏃舵覆鏌撲竴鍙ュ紩瀵兼枃妗堬紙`t('鍦ㄥ彸渚ф坊鍔犳潯鐩€?)`锛夎€屼笉鏄┖鐧斤紝璁╀綔鑰呯煡閬撲笅涓€姝ュ仛浠€涔堛€?- 鍥炬爣鐢ㄥ唴缃浘鏍囬泦锛坄navigation.ts` 鐨?`NAV_ICON_CHOICES`锛夛紝鏈煡鍥炬爣鍚嶉潤榛樹笉娓叉煋銆?- 妯悜姝ラ鍦ㄧ獎灞忚嚜鍔ㄩ€€鍖栦负绾靛悜锛堢敤 `@media (max-width: 767px)`锛屼笌 P1 鏂偣琛ㄤ竴鑷达級銆?- 鍗＄墖 hover 鍙仛棰滆壊鍙樺寲锛屼笉鍋氫綅绉伙紙`prefers-reduced-motion` 涓嬭嚜鐒舵棤鍔ㄧ敾锛夈€?
**姝ラ**锛氬厛鍐?`marketingBlocks.test.ts`锛堟柇瑷€涓夋潯瀹氫箟瀛樺湪銆乨efaults 閿?鈯?schema銆佹覆鏌撳櫒娉ㄥ唽鍦ㄧ敓浜?`RENDERERS` 閲岋級锛屽啀瀹炵幇锛屽啀琛?CSS锛屾渶鍚庤窇鍏ㄩ噺銆?
Commit: `git commit -m "feat(web): add the feature grid, card grid and steps blocks"`

---

