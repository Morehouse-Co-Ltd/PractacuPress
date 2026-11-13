### Task 3: `grid` 甯冨眬鍘熻

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛堟敞鍐?`grid`锛?- Modify: `apps/web/src/components/blocks/LayoutBlocks.tsx`锛坄GridBlock`锛?- Modify: `apps/web/src/components/blocks/index.tsx`锛堝垎娲撅級
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/gridBlock.test.ts`

**Interfaces:**
- Consumes: `SPACING_SCALE` / `spacingPx`銆乣BlockInstance.span/offset`銆?- Produces: `gridTemplate(block: BlockInstance): { columns: number; gap: number }`鈥斺€旂函鍑芥暟锛屼緵娓叉煋鍣ㄤ笌娴嬭瘯鍏辩敤銆?- Produces: `spanFor(block: BlockInstance, device: BuilderDevice): { span: number; offset: number }`鈥斺€斿す鍒?1鈥?2锛岀己鐪佹弧瀹姐€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// apps/web/src/lib/gridBlock.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { gridTemplate, spanFor } from './blocks';

function mk(extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id: 'g', type: 'grid', title: 'g', props: {}, animation: 'none', hidden: false, ...extra };
}

describe('gridTemplate', () => {
  it('榛樿 12 鏍忋€侀棿璺濇。浣?4', () => {
    expect(gridTemplate(mk({ props: {} }))).toEqual({ columns: 12, gap: 16 });
  });
  it('鏍忔暟澶瑰湪 1鈥?2', () => {
    expect(gridTemplate(mk({ props: { columns: 99 } })).columns).toBe(12);
    expect(gridTemplate(mk({ props: { columns: 0 } })).columns).toBe(1);
  });
  it('闂磋窛璧版爣灏猴紝闈炴硶妗ｄ綅鍥炶惤瀹炲績榛樿', () => {
    expect(gridTemplate(mk({ props: { gap: 9 } })).gap).toBe(96);
    expect(gridTemplate(mk({ props: { gap: 99 } })).gap).toBe(16);
  });
});

describe('spanFor', () => {
  it('娌℃湁 span 鏃跺崰婊℃暣琛?, () => {
    expect(spanFor(mk(), 'desktop')).toEqual({ span: 12, offset: 0 });
  });
  it('鎸夋柇鐐瑰彇 span', () => {
    const block = mk({ span: { base: 6, md: 8, sm: 12 }, offset: { base: 1 } });
    expect(spanFor(block, 'desktop')).toEqual({ span: 6, offset: 1 });
    expect(spanFor(block, 'tablet')).toEqual({ span: 8, offset: 1 });
    expect(spanFor(block, 'mobile')).toEqual({ span: 12, offset: 1 });
  });
  it('瓒婄晫涓€寰嬪す浣?, () => {
    expect(spanFor(mk({ span: { base: 99 }, offset: { base: 99 } }), 'desktop')).toEqual({
      span: 12,
      offset: 11,
    });
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/gridBlock.test.ts
```

Expected: FAIL 鈥斺€?`gridTemplate` / `spanFor` 鏈鍑恒€?
- [ ] **Step 3: 鍦?blocks.ts 鍔犵函鍑芥暟涓庢敞鍐岃〃鏉＄洰**

鍦?`apps/web/src/lib/blocks.ts` 鏈熬鍔狅細

```ts
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** grid 瀹瑰櫒鐨勬爮鏁颁笌闂磋窛锛坧x锛夛紱闂磋窛妗ｄ綅闈炴硶鏃跺洖钀藉埌 16px銆?*/
export function gridTemplate(block: BlockInstance): { columns: number; gap: number } {
  const columns = clampInt(block.props.columns, 1, 12, 12);
  const gap = spacingPx(clampInt(block.props.gap, 0, SPACING_SCALE.length - 1, 4)) ?? 16;
  return { columns, gap };
}

/** 瀛愬尯鍧楀湪鏌愪竴璁惧涓嬬殑鍗犱綅涓庡亸绉伙紱缂虹渷婊″銆佹棤鍋忕Щ銆?*/
export function spanFor(
  block: BlockInstance,
  device: BuilderDevice,
): { span: number; offset: number } {
  const pick = (value: { base?: number; md?: number; sm?: number } | undefined, fallback: number) => {
    if (!value) return fallback;
    if (device === 'tablet' && value.md !== undefined) return value.md;
    if (device === 'mobile' && value.sm !== undefined) return value.sm;
    return value.base ?? fallback;
  };
  return {
    span: clampInt(pick(block.span, 12), 1, 12, 12),
    offset: clampInt(pick(block.offset, 0), 0, 11, 0),
  };
}
```

鍦?`RAW_BLOCK_DEFS` 閲?`container` 鏉＄洰涔嬪悗杩藉姞锛?
```ts
  {
    type: 'grid',
    name: t('鏍呮牸'),
    description: t('12 鏍忔爡鏍煎鍣細瀛愬尯鍧楀彲浠ュ崰 1鈥?2 鏍忋€佸乏鍙冲亸绉伙紝鏍忚窛璧伴棿璺濇爣灏恒€?),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { columns: 12, gap: 4 },
    schema: [
      { key: 'columns', label: t('鏍忔暟'), type: 'number', min: 1, max: 12, step: 1 },
      { key: 'gap', label: t('鏍忚窛'), type: 'number', min: 0, max: 9, step: 1, hint: t('0鈥?锛屽搴?0鈥?6px 鐨勯棿璺濇爣灏恒€?) },
    ],
  },
  {
    type: 'section',
    name: t('鍒嗚妭'),
    description: t('涓€鏁存鐗堥潰锛氬彲闄愬銆佸彲璁句笂涓嬬暀鐧姐€佸彲鍔犲簳鑹蹭笌鍒嗛殧绾裤€?),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { max_width: 'normal', padding_y: 5, background: '', divider: false },
    schema: [
      {
        key: 'max_width',
        label: t('鍐呭瀹藉害'),
        type: 'select',
        options: [
          { value: 'narrow', label: t('绐勶紙640锛?) },
          { value: 'normal', label: t('甯歌锛?60锛?) },
          { value: 'wide', label: t('瀹斤紙1200锛?) },
          { value: 'full', label: t('婊″') },
        ],
      },
      { key: 'padding_y', label: t('涓婁笅鐣欑櫧'), type: 'number', min: 0, max: 9, step: 1, hint: t('0鈥?锛屽搴?0鈥?6px 鐨勯棿璺濇爣灏恒€?) },
      { key: 'background', label: t('搴曡壊'), type: 'color' },
      { key: 'divider', label: t('涓婁笅鍒嗛殧绾?), type: 'toggle' },
    ],
  },
```

椤堕儴 import 琛?`spacingPx`銆乣SPACING_SCALE`锛堟潵鑷?`./layout`锛夈€?
- [ ] **Step 4: 娓叉煋鍣?*

`apps/web/src/components/blocks/LayoutBlocks.tsx` 杩藉姞锛?
```tsx
/** 12 鏍忔爡鏍硷細瀛愬尯鍧楁寜 span/offset 钀戒綅锛屾柇鐐圭敤瀹瑰櫒鏌ヨ鑰屼笉鏄獟浣撴煡璇€?*/
export function GridBlock({
  block,
  renderChild,
}: {
  block: BlockInstance;
  renderChild: (child: BlockInstance) => ReactElement;
}) {
  const { columns, gap } = gridTemplate(block);
  return (
    <div
      className="pp-grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}
    >
      {(block.children ?? []).map((child) => (
        <div
          key={child.id}
          className="pp-grid-cell"
          style={{ gridColumn: `${gridColumnOf(child)} / span ${gridColumnOf(child, true)}` }}
        >
          {renderChild(child)}
        </div>
      ))}
    </div>
  );
}

/** 鍙湪娓叉煋鏈熺畻锛歞evice 鐢卞灞?CSS 鍙橀噺鍐冲畾锛岃繖閲屼骇鍑虹殑鏄熀纭€涓庢柇鐐逛袱濂楀€笺€?*/
function gridColumnOf(child: BlockInstance, span = false): number {
  const base = span ? spanFor(child, 'desktop').span : spanFor(child, 'desktop').offset + 1;
  return base;
}
```

> 鏂偣宸紓鍖栫敤 CSS 鍙橀噺 + 瀹瑰櫒鏌ヨ瀹炵幇锛歚GridBlock` 鍦ㄥ鍣ㄤ笂鍐?> `--span-base` / `--span-md` / `--span-sm`锛宍styles.css` 閲岀敤
> `@container (max-width: 1023px) { .pp-grid-cell { grid-column-end: span var(--span-md) } }`
> 涔嬬被鐨勮鍒欏垏鎹€傚疄鐜版椂鎶婅繖涓変釜鍙橀噺鍐欒繘 `style`锛孋SS 瑙勫垯涓夋。榻愬叏鍗冲彲锛?> 鍏蜂綋鍐欐硶鍦ㄦ姤鍛婇噷璐村嚭鏉ワ紝纭繚棰勮 iframe 鏀瑰搴︽椂鐪熺殑閲嶆帓銆?
鍦?`components/blocks/index.tsx` 鐨勫垎娲鹃摼閲岋紝`container` 鍒嗘敮涔嬪悗鍔?`grid`锛?
```tsx
      ) : block.type === 'grid' ? (
        <GridBlock block={block} renderChild={(child) => <BlockView key={child.id} block={child} />} />
```

- [ ] **Step 5: 楠屾敹**

```bash
npx vitest run && npm run typecheck && npm run build
```

Expected: 鍏ㄧ豢锛涙瀯寤轰綋绉閲?< 10 KB銆?
```bash
git add apps/web/src/lib/blocks.ts apps/web/src/lib/gridBlock.test.ts \
  apps/web/src/components/blocks/LayoutBlocks.tsx apps/web/src/components/blocks/index.tsx apps/web/src/styles.css
git commit -m "feat(web): add the 12-column grid block"
```

---

