### Task 1: 鏂偣銆侀棿璺濇爣灏轰笌 `at` 姹傚€?
P0 鎶?`BlockInstance.at` 寤烘ā濂戒簡锛屼絾娌℃湁浠讳綍鍦版柟璇诲畠锛涜繖涔熸槸 P0 鎶娿€屼笁绔竷灞€鎶樼畻銆嶆帹杩熺殑鍘熷洜銆?鏈换鍔¤ˉ涓婃眰鍊艰矾寰勶紝骞堕『鎵嬫妸涓ゅ浜掔浉鎵撴灦鐨勬柇鐐癸紙`builderDeviceForWidth` 鐢?640銆佹€濈淮閾?`is_mobile` 鐢?768锛?鏀舵暃鍒颁竴澶勩€?
**Files:**
- Create: `apps/web/src/lib/layout.ts`
- Test: `apps/web/src/lib/layout.test.ts`
- Modify: `apps/web/src/lib/blocks.ts:1049-1053`锛坄builderDeviceForWidth`锛?- Modify: `apps/web/src/lib/logic.ts`锛坄is_mobile` / `is_desktop` 鏀圭敤鍏变韩鏂偣锛?- Modify: `apps/web/src/components/blocks/index.tsx`锛坄ScreenRenderer` 搴旂敤瑕嗙洊锛?
**Interfaces:**
- Produces: `BREAKPOINT_SM = 480`銆乣BREAKPOINT_MD = 768`銆乣BREAKPOINT_LG = 1024`銆?- Produces: `SPACING_SCALE: readonly number[] = [0,4,8,12,16,24,32,48,64,96]` 涓?  `spacingPx(index: unknown): number | undefined`锛堣秺鐣屾垨闈炴暣鏁拌繑鍥?`undefined`锛夈€?- Produces: `overlayAt(block: BlockInstance, device: BuilderDevice): BlockInstance`鈥斺€?  杩斿洖鎶?`at[device]` 鍚堝苟杩涙潵鍚庣殑鏂板尯鍧楋紙涓嶄慨鏀瑰叆鍙傦紝閫掑綊杩?`children`锛夈€?- Produces: `applyDisplayOverrides(blocks: BlockInstance[], device: BuilderDevice): BlockInstance[]`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/layout.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import {
  BREAKPOINT_LG,
  BREAKPOINT_MD,
  BREAKPOINT_SM,
  SPACING_SCALE,
  applyDisplayOverrides,
  overlayAt,
  spacingPx,
} from './layout';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('鏂偣', () => {
  it('涓夋。浠庡皬鍒板ぇ涓斾笌鏂囨。涓€鑷?, () => {
    expect([BREAKPOINT_SM, BREAKPOINT_MD, BREAKPOINT_LG]).toEqual([480, 768, 1024]);
  });
});

describe('spacingPx', () => {
  it('鎸夋。浣嶄笅鏍囧彇鍊?, () => {
    expect(spacingPx(0)).toBe(0);
    expect(spacingPx(9)).toBe(96);
  });
  it('瓒婄晫銆侀潪鏁存暟銆侀潪鏁板瓧涓€寰?undefined', () => {
    expect(spacingPx(-1)).toBeUndefined();
    expect(spacingPx(99)).toBeUndefined();
    expect(spacingPx(1.5)).toBeUndefined();
    expect(spacingPx('3')).toBeUndefined();
  });
  it('鏍囧昂鏄彧璇诲父閲忎笖鍗曡皟閫掑', () => {
    expect(SPACING_SCALE).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
  });
});

describe('overlayAt', () => {
  it('鎵嬫満瑕嗙洊闅愯棌鏃跺彧褰卞搷鎵嬫満', () => {
    const block = mk('a', { at: { mobile: { hidden: true } } });
    expect(overlayAt(block, 'mobile').hidden).toBe(true);
    expect(overlayAt(block, 'desktop').hidden).toBe(false);
  });

  it('澶栬瀵硅薄鎸夊瓧娈靛悎骞讹紝涓嶆暣鍧楁浛鎹?, () => {
    const block = mk('a', {
      appearance: { radius: 'md', padding: 12 },
      at: { tablet: { appearance: { radius: 'xl' } } },
    });
    expect(overlayAt(block, 'tablet').appearance).toEqual({ radius: 'xl', padding: 12 });
  });

  it('閫掑綊杩涘瓙鍖哄潡', () => {
    const child = mk('c', { at: { mobile: { hidden: true } } });
    const parent = mk('p', { children: [child] });
    const mobile = overlayAt(parent, 'mobile');
    expect(mobile.children?.[0].hidden).toBe(true);
    expect(overlayAt(parent, 'desktop').children?.[0].hidden).toBe(false);
  });

  it('涓嶄慨鏀瑰叆鍙?, () => {
    const block = mk('a', { at: { mobile: { span: { base: 6 } } } });
    overlayAt(block, 'mobile');
    expect(block.span).toBeUndefined();
  });
});

describe('applyDisplayOverrides', () => {
  it('妗岄潰鍘熸牱杩斿洖锛坉esktop 娌℃湁瑕嗙洊灞傦級', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } })];
    expect(applyDisplayOverrides(blocks, 'desktop')[0].hidden).toBe(false);
  });
  it('鎵归噺搴旂敤鎵嬫満瑕嗙洊', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } }), mk('b')];
    expect(applyDisplayOverrides(blocks, 'mobile').map((b) => b.hidden)).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/layout.test.ts
```

Expected: FAIL 鈥斺€?`Cannot find module './layout'`銆?
- [ ] **Step 3: 鍐?layout.ts**

鏂板缓 `apps/web/src/lib/layout.ts`锛?
```ts
import type { BlockDisplayOverride, BlockInstance, BuilderDevice } from '../types';

/**
 * 鏂偣鐨勫敮涓€鏉ユ簮銆? *
 * P0 涔嬪墠浠撳簱閲屾湁涓ゅ锛歚builderDeviceForWidth` 鐢?640銆佹€濈淮閾剧殑 `is_mobile` 鐢?768銆? * 涓ゅ闃堝€兼剰鍛崇潃"鍚屼竴鍙拌澶囧湪缂栨帓鍣ㄥ拰閫昏緫閾鹃噷韬唤涓嶅悓"锛岃繖閲岀粺涓€銆? */
export const BREAKPOINT_SM = 480;
export const BREAKPOINT_MD = 768;
export const BREAKPOINT_LG = 1024;

/** 闂磋窛鏍囧昂锛氭柊瀛楁瀛樼殑鏄繖涓暟缁勭殑涓嬫爣锛屼笉鏄儚绱犮€?*/
export const SPACING_SCALE: readonly number[] = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];

/** 妗ｄ綅涓嬫爣 鈫?鍍忕礌锛涢潪娉曟。浣嶈繑鍥?undefined锛堣皟鐢ㄦ柟鎸?鏈缃?澶勭悊锛夈€?*/
export function spacingPx(index: unknown): number | undefined {
  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= SPACING_SCALE.length) return undefined;
  return SPACING_SCALE[index];
}

/** 杩欎竴灞傝鐩栭噷鐪熸瑕佸啓鐨勫瓧娈碉紱`desktop` 娌℃湁瑕嗙洊灞傘€?*/
function overrideOf(block: BlockInstance, device: BuilderDevice): BlockDisplayOverride | undefined {
  if (device === 'desktop') return undefined;
  return block.at?.[device];
}

/**
 * 鎶婃煇涓澶囩殑瑕嗙洊灞傚彔鍒板尯鍧椾笂銆? *
 * 鍙彔灞曠ず灞傦紙`BlockDisplayOverride` 澹版槑鐨勫瓧娈碉級锛宍props` 姘歌繙鍙湁涓€浠解€斺€? * 杩欐槸 P0 瀹氫笅鐨勮鐭╋紝鍐呭鍙屾簮鏄笁绔竷灞€褰撳勾澶辨帶鐨勬牴鍥犮€? */
export function overlayAt(block: BlockInstance, device: BuilderDevice): BlockInstance {
  const override = overrideOf(block, device);
  const children = block.children?.map((child) => overlayAt(child, device));
  const base: BlockInstance = children && children !== block.children ? { ...block, children } : block;
  if (!override) return base;

  const next: BlockInstance = { ...base };
  if (override.span) next.span = override.span;
  if (override.align) next.align = override.align;
  if (override.animation) next.animation = override.animation;
  if (override.hidden !== undefined) next.hidden = override.hidden;
  if (override.custom_css) next.custom_css = override.custom_css;
  if (override.width !== undefined) next.width = override.width;
  if (override.height !== undefined) next.height = override.height;
  if (override.gap_scale !== undefined) next.gap_scale = override.gap_scale;
  if (override.mt !== undefined) next.mt = override.mt;
  if (override.mb !== undefined) next.mb = override.mb;
  if (override.appearance) next.appearance = { ...base.appearance, ...override.appearance };
  return next;
}

/** 鎵归噺鍙犺鐩栵紱娓叉煋鍏ュ彛璋冪敤瀹冧竴娆★紝瀛愭爲閲屽氨涓嶅啀鍏冲績璁惧銆?*/
export function applyDisplayOverrides(
  blocks: BlockInstance[],
  device: BuilderDevice,
): BlockInstance[] {
  if (device === 'desktop') return blocks;
  return blocks.map((block) => overlayAt(block, device));
}
```

- [ ] **Step 4: 璁?`at` 鍦ㄧ被鍨嬩笂鍙敤**

`BlockInstance` 鐩墠娌℃湁 `align` / `gap_scale` / `mt` / `mb` 杩欏嚑涓《灞傚瓧娈碉紙瀹冧滑鍙瓨鍦ㄤ簬
`BlockDisplayOverride` 閲岋級銆傚湪 `apps/web/src/types.ts` 鐨?`BlockInstance` 閲?`offset?: BlockOffset;` 涔嬪悗杩藉姞锛?
```ts
  /** 瀛愬尯鍧楀湪鏍呮牸閲岀殑姘村钩瀵归綈锛圥1锛夈€?*/
  align?: 'left' | 'center' | 'right';
  /** 鏍呮牸闂磋窛妗ｄ綅锛圥1锛屼綔鐢ㄤ簬 grid 瀹瑰櫒锛夈€?*/
  gap_scale?: number;
  /** 涓婂杈硅窛妗ｄ綅锛圥1锛岄棿璺濇爣灏虹殑涓嬫爣锛夈€?*/
  mt?: number;
  /** 涓嬪杈硅窛妗ｄ綅锛圥1锛岄棿璺濇爣灏虹殑涓嬫爣锛夈€?*/
  mb?: number;
```

- [ ] **Step 5: 璺戞祴璇曠‘璁ら€氳繃**

```bash
npx vitest run src/lib/layout.test.ts && npm run typecheck
```

Expected: 鍏ㄩ儴 PASS锛? 绫诲瀷閿欒銆?
- [ ] **Step 6: 鏀舵暃鏂偣**

`apps/web/src/lib/blocks.ts` 鐨?`builderDeviceForWidth` 鎹㈡垚锛?
```ts
/** 鎸夌獥鍙ｅ搴﹀垽鏂綋鍓嶈澶囷紱闃堝€兼潵鑷?lib/layout.ts 鐨勫敮涓€鏂偣琛ㄣ€?*/
export function builderDeviceForWidth(width: number): BuilderDevice {
  if (width < BREAKPOINT_MD) return 'mobile';
  if (width < BREAKPOINT_LG) return 'tablet';
  return 'desktop';
}
```

锛堥《閮ㄤ粠 `./layout` 寮曞叆 `BREAKPOINT_MD` / `BREAKPOINT_LG`銆傦級

`apps/web/src/lib/logic.ts` 閲?`is_mobile` / `is_desktop` 鐨?768 鏀圭敤 `BREAKPOINT_MD`锛?骞跺湪娉ㄩ噴閲屽啓鏄?涓庣紪鎺掑櫒鍏辩敤鍚屼竴寮犳柇鐐硅〃"銆?
- [ ] **Step 7: 鍦ㄦ覆鏌撳叆鍙ｅ簲鐢ㄨ鐩?*

`apps/web/src/components/blocks/index.tsx` 鐨?`ScreenRenderer` 閲岋紝鎶婏細

```ts
  const blocks = screenBlocksForDevice(layout, device).filter((block) => !block.hidden);
```

鏀规垚锛?
```ts
  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device).filter(
    (block) => !block.hidden,
  );
```

锛坄applyDisplayOverrides` 浠?`../../lib/layout` 寮曞叆銆傦級

- [ ] **Step 8: 鍏ㄩ噺楠岃瘉骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
```

Expected: 52 鏂囦欢 / 575 浠ヤ笂娴嬭瘯鍏ㄩ儴 PASS锛? 绫诲瀷閿欒锛坄builderDeviceForWidth` 闃堝€煎彉鍖栦笉浼?璁╂棦鏈夋祴璇曞彉绾⑩€斺€旇嫢鏈夋祴璇曞啓姝讳簡 640锛屾寜鏂伴槇鍊兼敼鏂█锛屽苟鍦ㄦ姤鍛婇噷璇存槑锛夈€?
```bash
git add apps/web/src/lib/layout.ts apps/web/src/lib/layout.test.ts apps/web/src/lib/blocks.ts \
  apps/web/src/lib/logic.ts apps/web/src/types.ts apps/web/src/components/blocks/index.tsx
git commit -m "feat(web): evaluate per-device overrides and unify the breakpoint table"
```

---

