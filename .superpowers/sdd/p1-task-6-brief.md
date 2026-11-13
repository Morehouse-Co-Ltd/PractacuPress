### Task 6: 鎵撳紑 v1 涓夌甯冨眬鐨勮嚜鍔ㄦ姌绠?
P0 鎶?`foldDeviceLayouts` 鐣欐垚浜?绛?`at` 姹傚€煎悗鍐嶈皟鐢?銆俆ask 1 宸茬粡璁╂覆鏌撳眰鐪熸璇?`at`锛?鐜板湪鍙互鎵撳紑瀹冧簡銆?
**Files:**
- Modify: `apps/web/src/lib/customize.ts`
- Modify: `apps/web/src/lib/migrate.ts`
- Test: `apps/web/src/lib/migrate.test.ts`锛堣拷鍔狅級

**Interfaces:**
- Consumes: `foldDeviceLayouts`锛圥0锛夈€乣applyDisplayOverrides`锛圱ask 1锛夈€?- Produces: `readCustomization` 瀵?v1 鏂囨。锛堟棤 `schema_version` 鎴?`< 2`锛夊厛鎶樼畻鍐嶅綊涓€鍖栥€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鍦?`migrate.test.ts` 杩藉姞锛?
```ts
it('v1 鏂囨。鍦ㄨ鍙栨椂鎶婁笁绔竷灞€鎶樼畻鎴?at锛堝洜涓烘覆鏌撳眰宸茬粡姹傚€?at锛?, () => {
  const { value } = migrateCustomization(
    {
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a', { hidden: true })] } },
      },
    },
    { foldDevices: true },
  );
  const home = value.home as Record<string, unknown>;
  expect((home.blocks as Array<Record<string, unknown>>)[0].at).toEqual({ mobile: { hidden: true } });
  expect(home.devices).toBeUndefined();
});
```

锛坄migrateCustomization` 澧炲姞绗簩涓彲閫夊弬鏁?`{ foldDevices?: boolean }`锛岄粯璁?`false`鈥斺€?P0 鐨勮涓轰繚鎸侀粯璁わ紝鍙湁 `readCustomization` 鏄惧紡鎵撳紑瀹冦€傦級

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: FAIL 鈥斺€?绗簩涓弬鏁拌繕涓嶅瓨鍦ㄣ€?
- [ ] **Step 3: 瀹炵幇骞舵帴绾?*

`migrate.ts`锛歚migrateCustomization(raw, options = {})`锛涘綋 `options.foldDevices === true` 鏃讹紝
瀵?`home` / `article` / `pages[].layout` 璋冪敤 `foldDeviceLayouts`锛屾妸鎶ュ憡鍚堝苟杩?`report`銆?
`customize.ts` 鐨?`readCustomization` 鏀规垚锛?
```ts
const migrated = migrateCustomization(config.customization, { foldDevices: true });
```

- [ ] **Step 4: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/migrate.ts apps/web/src/lib/migrate.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): fold legacy split-device layouts now that at is rendered"
```

---

