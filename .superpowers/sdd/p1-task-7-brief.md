### Task 7: 缂栬緫鍣ㄧ殑缁ф壙 / 瑕嗙洊鎬?
**Files:**
- Modify: `apps/web/src/components/builder/BlockInspector.tsx`
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`
- Test: 宸叉湁缁勪欢娴嬭瘯妯″紡涓嬭ˉ涓€涓?`BlockInspector` 鐨勮交閲忔柇瑷€锛堣嫢椤圭洰娌℃湁缁勪欢娴嬭瘯鍩哄缓锛屽垯鍦ㄦ姤鍛婇噷璇存槑骞跺彧鍋氱被鍨嬩笌鐜版湁娴嬭瘯鍥炲綊锛?
**Interfaces:**
- Consumes: `overlayAt`銆乣BlockDisplayOverride`銆?- Produces: `writeOverride(block: BlockInstance, device: BuilderDevice, patch: BlockDisplayOverride): BlockInstance`鈥斺€?  闈炴闈㈣澶囨椂鍐欒繘 `at[device]`锛涙闈㈠啓鍥炲熀纭€瀛楁銆傛斁鍦?`lib/layout.ts`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*锛堣拷鍔犲埌 `layout.test.ts`锛?
```ts
import { writeOverride } from './layout';

it('鎵嬫満涓婃敼澶栬鍐欒繘 at.mobile锛屼笉鍔ㄥ熀纭€澶栬', () => {
  const block = mk('a', { appearance: { radius: 'md' } });
  const next = writeOverride(block, 'mobile', { appearance: { radius: 'xl' } });
  expect(next.appearance).toEqual({ radius: 'md' });
  expect(next.at?.mobile?.appearance).toEqual({ radius: 'xl' });
});

it('妗岄潰涓婃敼澶栬鍐欏洖鍩虹瀛楁', () => {
  const block = mk('a', { appearance: { radius: 'md' } });
  const next = writeOverride(block, 'desktop', { appearance: { radius: 'xl' } });
  expect(next.appearance).toEqual({ radius: 'xl' });
  expect(next.at?.desktop).toBeUndefined();
});

it('鎭㈠缁ф壙锛氫紶绌?patch 鏃跺垹鎺夎璁惧鐨勮鐩?, () => {
  const block = mk('a', { at: { mobile: { hidden: true } } });
  const next = writeOverride(block, 'mobile', {});
  expect(next.at?.mobile).toBeUndefined();
});
```

- [ ] **Step 2: 瀹炵幇 `writeOverride`**锛坄lib/layout.ts`锛?
瑙勫垯锛歚desktop` 鐩存帴鍚堝苟鍒伴《灞傦紱鍏朵綑璁惧鎶?patch 鍚堝苟杩?`at[device]`锛?鍚堝苟鍚庤璁惧瑕嗙洊涓虹┖瀵硅薄鏃跺垹鎺夎繖涓敭锛沗at` 鍙樼┖鏃跺垹鎺?`at`銆?
- [ ] **Step 3: 缂栬緫鍣ㄦ帴绾?*

`BlockInspector` 鐨勫睘鎬у啓鍏ヤ粠 `patch({ appearance })` 鏀逛负
`patch(writeOverride(block, device, { appearance }))`鈥斺€擿device` 鐢?`ThemeBuilder` 浼犱笅鏉ャ€?闈炴闈㈣澶囨椂锛屾瘡鏉¤瑕嗙洊鐨勫睘鎬ф梺鏄剧ず銆屽凡瑕嗙洊銆嶅苟缁欎竴涓€屾仮澶嶇户鎵裤€嶆寜閽紙璋?`writeOverride(block, device, {})`锛夈€?`ThemeBuilder` 鍒囨崲璁惧鏃?*涓嶅啀 `history.reset`**锛氭挙閿€鏍堣法璁惧淇濈暀锛屽洜涓虹幇鍦ㄦ敼鐨勫彲鑳芥槸鍚屼竴妫垫爲鐨勪笉鍚屽眰銆?
- [ ] **Step 4: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/layout.ts apps/web/src/lib/layout.test.ts \
  apps/web/src/components/builder/BlockInspector.tsx apps/web/src/pages/admin/ThemeBuilder.tsx
git commit -m "feat(web): edit per-device overrides in the inspector"
```

---

