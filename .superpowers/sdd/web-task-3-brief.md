### Task 3: 妯″瀷 v2 瀛楁 + schema_version + 杩佺Щ鍣?
**Files:**
- Modify: `apps/web/src/types.ts`锛坄BlockInstance` 澧炲姞灞曠ず灞傝鐩栧瓧娈碉紱`SiteCustomization` 澧炲姞 `schema_version`锛?- Create: `apps/web/src/lib/migrate.ts`
- Modify: `apps/web/src/lib/customize.ts`锛坄readCustomization` 鍏ュ彛璋冪敤杩佺Щ锛?- Test: `apps/web/src/lib/migrate.test.ts`锛堟柊寤猴級

**Interfaces:**
- Produces: `CURRENT_SCHEMA_VERSION = 2`銆?- Produces: `migrateCustomization(raw: unknown): { value: Record<string, unknown>; report: string[] }`鈥斺€?  绾嚱鏁般€佸箓绛夛紱`report` 鏄粰鐢ㄦ埛鐪嬬殑涓枃鍙ュ瓙锛岀┖鏁扮粍琛ㄧず"鏃犻渶鎻愮ず"銆?- Produces: `BlockInstance.at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride }`銆?  `visible?: BlockVisibility`銆乣anchor?: string`銆乣span?: BlockSpan`銆乣offset?: BlockSpan`鈥斺€?  Task 4/5 涓?P1 閮戒細鐢ㄥ埌锛孭0 鍙礋璐ｆ妸绫诲瀷涓庤縼绉诲啓瀵癸紝娓叉煋鏆備笉娑堣垂銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/migrate.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateCustomization } from './migrate';

function block(id: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('migrateCustomization', () => {
  it('缁欐病鏈夌増鏈彿鐨勬枃妗ｈˉ涓婄増鏈彿', () => {
    const { value } = migrateCustomization({ home: { blocks: [] } });
    expect(value.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('宸茬粡鏄?v2 鐨勬枃妗ｅ師鏍疯繑鍥炪€佷笉浜х敓鎶ュ憡', () => {
    const input = { schema_version: 2, home: { blocks: [] } };
    const { value, report } = migrateCustomization(input);
    expect(value).toEqual(input);
    expect(report).toEqual([]);
  });

  it('涓夋５鏍戠粨鏋勫畬鍏ㄧ浉鍚屾椂鎶樼畻鎴?at 瑕嗙洊骞朵涪鎺夊垎璁惧鍓湰', () => {
    const { value, report } = migrateCustomization({
      home: {
        blocks: [block('a'), block('b')],
        device_split: true,
        devices: {
          desktop: { blocks: [block('a'), block('b')] },
          mobile: { blocks: [block('a'), block('b', { hidden: true })] },
        },
      },
    });
    const home = value.home as Record<string, unknown>;
    const blocks = home.blocks as Array<Record<string, unknown>>;
    expect(blocks[1].at).toEqual({ mobile: { hidden: true } });
    expect(home.device_split).toBeUndefined();
    expect(home.devices).toBeUndefined();
    expect(report.join('')).toContain('鎵嬫満');
  });

  it('缁撴瀯涓嶅悓鏃朵繚鐣欏垎璁惧鍓湰骞跺湪鎶ュ憡閲岃鏄?, () => {
    const { value, report } = migrateCustomization({
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a'), block('only-mobile')] } },
      },
    });
    const home = value.home as Record<string, unknown>;
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(report.join('')).toContain('缁撴瀯涓嶅悓');
  });

  it('鍧忔暟鎹笉鎶涘紓甯?, () => {
    expect(() => migrateCustomization(null)).not.toThrow();
    expect(() => migrateCustomization({ home: 'nope' })).not.toThrow();
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: FAIL 鈥斺€?`Cannot find module './migrate'`銆?
- [ ] **Step 3: 鍦?types.ts 澧炲姞 v2 瀛楁**

鍦?`apps/web/src/types.ts` 鐨?`BlockInstance` 閲?`unsupported?: boolean;` 涔嬪悗杩藉姞锛?
```ts
  /** 鍙鐩栧睍绀哄眰锛屼笉瑕嗙洊 props锛涚己鐪佽〃绀烘部鐢ㄥ熀纭€鍊笺€?*/
  at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride };
  /** 鍐呯疆鏉′欢鏄剧ず锛涙覆鏌撴湡姹傚€硷紝鍒锋柊鍚庝粛鐒剁敓鏁堛€?*/
  visible?: BlockVisibility;
  /** 鐩綍 / 璺宠浆閿氱偣銆?*/
  anchor?: string;
  /** 鏍呮牸鍗犱綅锛涗笌 width 鍚屾椂瀛樺湪鏃?span 浼樺厛銆?*/
  span?: BlockSpan;
  /** 鏍呮牸璧峰鍒楀亸绉汇€?*/
  offset?: BlockSpan;
```

鍦ㄥ悓涓€涓枃浠剁殑 `SitePage` 瀹氫箟涔嬪墠鎻掑叆锛?
```ts
export interface BlockSpan {
  base: number; // 1鈥?2
  md?: number;  // 鈮?68
  sm?: number;  // 鈮?80
}

export type BlockDisplayOverride = Pick<
  BlockInstance,
  'span' | 'appearance' | 'animation' | 'hidden' | 'custom_css' | 'width' | 'height'
> & {
  align?: 'left' | 'center' | 'right';
  gap_scale?: number;
  mt?: number;
  mb?: number;
};

export interface BlockVisibility {
  devices?: BuilderDevice[];
  roles?: ('guest' | 'member' | 'admin')[];
  /** ISO 鏃ユ湡锛屽惈棣栧熬銆?*/
  from?: string;
  to?: string;
}
```

鍦?`SiteCustomization` 鎺ュ彛閲?`language?: Locale;` 涔嬪悗杩藉姞锛?
```ts
  /** 璁捐鏂囨。鐨勭粨鏋勭増鏈紱缂虹渷鎸?1 澶勭悊锛岃鍏ユ椂鐢?migrate.ts 鍗囩骇鍒?2銆?*/
  schema_version?: number;
```

- [ ] **Step 4: 鍐?migrate.ts**

鏂板缓 `apps/web/src/lib/migrate.ts`锛?
```ts
import type { BlockInstance, ScreenLayout } from '../types';

/**
 * 璁捐鏂囨。鐨勭粨鏋勭増鏈€? *
 * 1 鈫?2锛氫笁绔€屾暣妫垫爲澶嶅埗涓変唤銆嶆敼涓恒€屼竴浠藉熀纭€缂栨帓 + 灞曠ず灞傝鐩栥€嶃€? * 杩佺Щ鍙湪缁撴瀯瀹屽叏涓€鑷存椂鎶樼畻锛涚粨鏋勪笉鍚岀殑璁惧缂栨帓淇濈暀锛屽啓杩涙姤鍛婁氦缁欑敤鎴峰喅瀹氥€? */
export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationResult {
  value: Record<string, unknown>;
  /** 缁欑敤鎴风湅鐨勪腑鏂囨彁绀猴紱绌烘暟缁勮〃绀鸿繖娆¤鍙栦笉闇€瑕佹墦鎵扮敤鎴枫€?*/
  report: string[];
}

/** 鍏佽琚?at 瑕嗙洊鐨勫睍绀哄眰瀛楁銆?*/
const DISPLAY_KEYS = [
  'span',
  'appearance',
  'animation',
  'hidden',
  'custom_css',
  'width',
  'height',
] as const;

const DEVICE_LABEL: Record<string, string> = { tablet: '骞虫澘', mobile: '鎵嬫満' };

function sameShape(a: BlockInstance[], b: BlockInstance[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
    if (!sameShape(a[i].children ?? [], b[i].children ?? [])) return false;
  }
  return true;
}

function diffDisplay(base: BlockInstance, other: BlockInstance): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of DISPLAY_KEYS) {
    if (JSON.stringify(base[key]) !== JSON.stringify(other[key])) patch[key] = other[key];
  }
  return patch;
}

/** 鎶?`other` 鐩稿 `base` 鐨勫睍绀哄眰宸紓鍐欐垚 base 涓婄殑 at銆傝繑鍥炴槸鍚︾湡鐨勫啓浜嗐€?*/
function foldDisplay(base: BlockInstance[], other: BlockInstance[], device: string): boolean {
  if (!sameShape(base, other)) return false;
  let changed = false;
  const walk = (a: BlockInstance[], b: BlockInstance[]) => {
    for (let i = 0; i < a.length; i += 1) {
      const patch = diffDisplay(a[i], b[i]);
      if (Object.keys(patch).length) {
        const at = { ...(a[i].at ?? {}) } as Record<string, Record<string, unknown>>;
        at[device] = { ...(at[device] ?? {}), ...patch };
        a[i] = { ...a[i], at: at as BlockInstance['at'] };
        changed = true;
      }
      walk(a[i].children ?? [], b[i].children ?? []);
    }
  };
  walk(base, other);
  return changed;
}

function foldLayout(raw: unknown, label: string, report: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const layout = raw as ScreenLayout & Record<string, unknown>;
  if (layout.device_split !== true || !layout.devices) return raw;

  const devices = { ...layout.devices } as Record<string, { blocks: BlockInstance[] } | undefined>;
  const base = Array.isArray(layout.blocks) ? structuredClone(layout.blocks) : [];
  let folded = 0;
  const kept: string[] = [];

  for (const device of ['tablet', 'mobile'] as const) {
    const entry = devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    if (foldDisplay(base, structuredClone(entry.blocks), device)) {
      folded += 1;
      delete devices[device];
    } else {
      kept.push(DEVICE_LABEL[device]);
    }
  }

  // 妗岄潰鐗堟湰灏辨槸 base锛岀粨鏋勭浉鍚屾椂瀹冩槸鍐椾綑鐨勶紝鐩存帴涓㈡帀銆?  if (devices.desktop && sameShape(base, devices.desktop.blocks)) delete devices.desktop;

  if (folded) report.push(`${label}锛氬凡鎶?${folded} 绔笌妗岄潰涓嶅悓鐨勫睍绀鸿缃姌绠楁垚瑕嗙洊銆俙);
  if (kept.length) report.push(`${label}锛?{kept.join('銆?)}甯冨眬涓庢闈㈢粨鏋勪笉鍚岋紝淇濈暀涓虹嫭绔嬬紪鎺掋€俙);

  if (!diffAnyDevice(devices)) {
    return { blocks: base };
  }
  return { blocks: base, device_split: true, devices };
}

function diffAnyDevice(devices: Record<string, unknown>): boolean {
  return Object.keys(devices).length > 0;
}

export function migrateCustomization(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, report: [] };
  const doc: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  if (version >= CURRENT_SCHEMA_VERSION) return { value: doc, report: [] };

  const report: string[] = [];
  if (doc.home) doc.home = foldLayout(doc.home, '棣栭〉', report);
  if (doc.article) doc.article = foldLayout(doc.article, '鏂囩珷椤?, report);
  if (Array.isArray(doc.pages)) {
    doc.pages = doc.pages.map((page, index) => {
      if (!page || typeof page !== 'object') return page;
      const entry = page as Record<string, unknown>;
      if (!entry.layout) return page;
      return { ...entry, layout: foldLayout(entry.layout, `椤甸潰銆?{String(entry.title ?? index)}銆峘, report) };
    });
  }
  doc.schema_version = CURRENT_SCHEMA_VERSION;
  return { value: doc, report };
}
```

- [ ] **Step 5: 璺戞祴璇曠‘璁ら€氳繃**

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: 5 涓敤渚嬪叏閮?PASS銆?
- [ ] **Step 6: 鎺ュ埌 readCustomization 鍏ュ彛**

鍦?`apps/web/src/lib/customize.ts` 椤堕儴 import 鍖哄姞鍏ワ細

```ts
import { migrateCustomization } from './migrate';
```

鎵惧埌 `readCustomization` 鐨勫嚱鏁颁綋绗竴琛岋紙鎶婂叆鍙傞厤缃鎴?`config.customization` 鐨勯偅澶勶級锛?鍦ㄦ渶鍓嶉潰鎻掑叆杩佺Щ锛?
```ts
export function readCustomization(config: WebConfig): SiteCustomization {
  const migrated = migrateCustomization(config.customization).value;
  const raw = migrated as Partial<SiteCustomization>;
  // 鈥﹀師鏈夊嚱鏁颁綋锛屾妸鍘熸潵璇?config.customization 鐨勫湴鏂规敼鎴愯 raw
}
```

娉ㄦ剰锛?*鍙敼璇诲彇璺緞**銆備繚瀛樿矾寰勶紙`customizationSync.ts` 鐨?PUT锛変粛鐒跺啓鍘熷瀵硅薄锛?杩佺Щ缁撴灉鍦ㄤ笅涓€娆′繚瀛樻椂鑷劧钀界洏銆?
- [ ] **Step 7: 璺戝叏閲忔祴璇曚笌绫诲瀷妫€鏌?*

```bash
npx vitest run && npm run typecheck
```

Expected: 鍏ㄧ豢锛? 绫诲瀷閿欒銆?
- [ ] **Step 8: 鎻愪氦**

```bash
git add apps/web/src/types.ts apps/web/src/lib/migrate.ts apps/web/src/lib/migrate.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): add schema v2 block fields, version stamp and the v1 to v2 migrator"
```

---

