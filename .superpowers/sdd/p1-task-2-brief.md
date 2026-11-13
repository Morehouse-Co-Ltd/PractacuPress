### Task 2: 鍐呯疆鏉′欢鏄剧ず锛坄visible`锛?
**Files:**
- Create: `apps/web/src/lib/visibility.ts`
- Test: `apps/web/src/lib/visibility.test.ts`
- Modify: `apps/web/src/components/blocks/index.tsx`

**Interfaces:**
- Consumes: `overlayAt`锛圱ask 1锛夈€?- Produces: `type ViewerRole = 'guest' | 'member' | 'admin'`銆?- Produces: `isVisibleAt(block: Pick<BlockInstance, 'visible'>, ctx: { device, role, now }): boolean`銆?- Produces: `roleFromSession(me: Me | null): ViewerRole`鈥斺€擿null` 鈫?guest锛沗platform_admin`/`site_admin` 鈫?admin锛涘叾浣欑櫥褰曠敤鎴?鈫?member銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/visibility.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { isVisibleAt } from './visibility';

const now = new Date('2026-11-03T12:00:00Z');
const ctx = (role: 'guest' | 'member' | 'admin' = 'guest', device: 'desktop' | 'mobile' = 'desktop') => ({
  role,
  device,
  now,
});

describe('isVisibleAt', () => {
  it('娌℃湁 visible 灏辨槸鍙', () => {
    expect(isVisibleAt({}, ctx())).toBe(true);
  });

  it('璁惧鐧藉悕鍗?, () => {
    const block = { visible: { devices: ['mobile' as const] } };
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'desktop'))).toBe(false);
  });

  it('瑙掕壊鐧藉悕鍗?, () => {
    const block = { visible: { roles: ['member' as const, 'admin' as const] } };
    expect(isVisibleAt(block, ctx('guest'))).toBe(false);
    expect(isVisibleAt(block, ctx('member'))).toBe(true);
  });

  it('鏃堕棿绐楀墠鍙銆佺獥鍐呭彲瑙併€佺獥鍚庝笉鍙', () => {
    const block = { visible: { from: '2026-11-01', to: '2026-11-10' } };
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-10-31T00:00:00Z') })).toBe(false);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-05T00:00:00Z') })).toBe(true);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-11T00:00:00Z') })).toBe(false);
  });

  it('鍧忔棩鏈熶竴寰嬪綋浣滄病鏈夎繖涓檺鍒讹紝涓嶆姏寮傚父', () => {
    const block = { visible: { from: 'not-a-date' } };
    expect(() => isVisibleAt(block, ctx())).not.toThrow();
    expect(isVisibleAt(block, ctx())).toBe(true);
  });

  it('涓変釜鏉′欢鍚屾椂瀛樺湪鏃跺叏閮ㄦ弧瓒虫墠鍙', () => {
    const block = {
      visible: { devices: ['mobile' as const], roles: ['member' as const], from: '2026-11-01' },
    };
    expect(isVisibleAt(block, ctx('member', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(false);
    expect(isVisibleAt(block, ctx('member', 'desktop'))).toBe(false);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/visibility.test.ts
```

Expected: FAIL 鈥斺€?妯″潡涓嶅瓨鍦ㄣ€?
- [ ] **Step 3: 鍐?visibility.ts**

```ts
import type { BlockInstance, BuilderDevice, Me } from '../types';

/** 璁垮鍦ㄨ繖娆℃覆鏌撻噷鎵紨鐨勮鑹层€?*/
export type ViewerRole = 'guest' | 'member' | 'admin';

export interface VisibilityContext {
  device: BuilderDevice;
  role: ViewerRole;
  now: Date;
}

/** 浠庣櫥褰曟€佹帹鍑鸿鑹层€備釜浜虹珯鐐归噷鎵€鏈夌櫥褰曡处鎴烽兘鏄鐞嗗憳锛岀敱 me.role 鐩存帴鍐冲畾銆?*/
export function roleFromSession(me: Me | null): ViewerRole {
  if (!me) return 'guest';
  return me.role === 'platform_admin' || me.role === 'site_admin' ? 'admin' : 'member';
}

function dateOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 鏉′欢鏄剧ず姹傚€笺€? *
 * 涓夌粍鏉′欢鍏ㄩ儴婊¤冻鎵嶅彲瑙侊紱缂烘煇缁勮〃绀鸿缁勪笉璁鹃檺銆傚潖鏃ユ湡鎸?娌″啓"澶勭悊鈥斺€? * 涓€涓墜婊戠殑鏃ユ湡涓嶈璁╂暣鍧楀唴瀹逛粠绔欑偣涓婃秷澶便€? *
 * 娉ㄦ剰锛氳繖鏄帓鐗堝伐鍏凤紝涓嶆槸璁块棶鎺у埗銆傜珯鐐硅璁℃枃妗ｅ鎵€鏈夎瀹㈡槸鍚屼竴浠藉叕寮€ JSON锛? * 鐢?visible 钘忓唴瀹逛笉鏋勬垚瀹夊叏杈圭晫銆? */
export function isVisibleAt(
  block: Pick<BlockInstance, 'visible'>,
  ctx: VisibilityContext,
): boolean {
  const visible = block.visible;
  if (!visible) return true;

  if (visible.devices?.length && !visible.devices.includes(ctx.device)) return false;
  if (visible.roles?.length && !visible.roles.includes(ctx.role)) return false;

  const now = ctx.now.getTime();
  const from = dateOf(visible.from);
  const to = dateOf(visible.to);
  if (from !== null && now < from) return false;
  // to 鏄€屽惈褰撳ぉ銆嶏細鎶婄粨鏉熸棩鏈熷綋浣滈偅澶╃殑鏈€鍚庝竴姣銆?  if (to !== null && now > to + 86_399_999) return false;
  return true;
}
```

- [ ] **Step 4: 鎺ヨ繘娓叉煋鍏ュ彛**

`components/blocks/index.tsx` 鐨?`ScreenRenderer`锛?
```tsx
  const { me } = useAuth();
  const role = roleFromSession(me);
  const now = useMemo(() => new Date(), []);
  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device)
    .filter((block) => !block.hidden)
    .filter((block) => isVisibleAt(block, { device, role, now }));
```

`useAuth` 鏉ヨ嚜 `../../lib/session`锛沗useMemo` 鍔犺繘 react import銆?瀛愬尯鍧楃殑杩囨护鏀惧湪 `BlockView` 閲岋細瀹瑰櫒娓叉煋 `visibleChildren` 涔嬪墠锛屽悓鏍锋寜 `isVisibleAt` 杩囨护
锛坄BlockView` 閲屽凡缁忔湁 `visibleChildren` 鐨勮绠楋紝鎶?`.filter((child) => !child.hidden)` 鎵╂垚
涓や釜杩囨护鏉′欢鍗冲彲锛涜鑹蹭笌 now 閫氳繃 props 浠?`ScreenRenderer` 浼犱笅鍘伙紝鎴栫敤涓€涓交閲忕殑
`VisibilityContext` React context鈥斺€旈€夊悗鑰呯殑瀹炵幇瑕佸湪鎶ュ憡閲岃鏄庣悊鐢憋級銆?
- [ ] **Step 5: 鍏ㄩ噺楠岃瘉骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/visibility.ts apps/web/src/lib/visibility.test.ts apps/web/src/components/blocks/index.tsx
git commit -m "feat(web): evaluate per-block visibility at render time"
```

---

