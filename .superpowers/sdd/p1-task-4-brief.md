### Task 4: `section` 甯冨眬鍘熻

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛堟敞鍐屾潯鐩凡闅?Task 3 鍔犲ソ锛屾湰浠诲姟琛ユ覆鏌撴墍闇€绾嚱鏁帮級
- Modify: `apps/web/src/components/blocks/LayoutBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/sectionBlock.test.ts`

**Interfaces:**
- Consumes: `spacingPx`銆乣SPACING_SCALE`銆?- Produces: `sectionLayout(block: BlockInstance): { maxWidth?: number; paddingY: number; background?: string; divider: boolean }`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

```ts
// apps/web/src/lib/sectionBlock.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { sectionLayout } from './blocks';

function mk(props: Record<string, unknown> = {}): BlockInstance {
  return { id: 's', type: 'section', title: 's', props, animation: 'none', hidden: false };
}

describe('sectionLayout', () => {
  it('榛樿甯歌瀹藉害銆佺暀鐧芥。 5锛?2px锛夈€佹棤搴曡壊銆佹棤鍒嗛殧绾?, () => {
    expect(sectionLayout(mk())).toEqual({ maxWidth: 860, paddingY: 32, background: undefined, divider: false });
  });
  it('婊″涓嶈 maxWidth', () => {
    expect(sectionLayout(mk({ max_width: 'full' })).maxWidth).toBeUndefined();
  });
  it('鍧忔。浣嶅洖钀?32px锛屽潖棰滆壊琚涪寮?, () => {
    expect(sectionLayout(mk({ padding_y: 99 })).paddingY).toBe(32);
    expect(sectionLayout(mk({ background: 'not-a-color' })).background).toBeUndefined();
  });
  it('鍒嗛殧绾垮紑鍏?, () => {
    expect(sectionLayout(mk({ divider: true })).divider).toBe(true);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/sectionBlock.test.ts
```

- [ ] **Step 3: 瀹炵幇**

`blocks.ts` 鏈熬锛?
```ts
const SECTION_WIDTHS: Record<string, number | undefined> = {
  narrow: 640,
  normal: 860,
  wide: 1200,
  full: undefined,
};

/** section 鐨勫彇瀹藉甫涓庣暀鐧斤紱棰滆壊鍙帴鍙?#rgb / #rrggbb / #rrggbbaa銆?*/
export function sectionLayout(block: BlockInstance): {
  maxWidth?: number;
  paddingY: number;
  background?: string;
  divider: boolean;
} {
  const raw = block.props;
  const width = typeof raw.max_width === 'string' ? raw.max_width : 'normal';
  const paddingY = spacingPx(typeof raw.padding_y === 'number' ? raw.padding_y : 5) ?? 32;
  const color = typeof raw.background === 'string' ? raw.background.trim() : '';
  return {
    maxWidth: SECTION_WIDTHS[width] ?? 860,
    paddingY,
    background: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : undefined,
    divider: raw.divider === true,
  };
}
```

`LayoutBlocks.tsx` 杩藉姞锛?
```tsx
/** 鍒嗚妭锛氶檺瀹?+ 涓婁笅鐣欑櫧 + 鍙€夊簳鑹蹭笌涓婁笅鍒嗛殧绾裤€?*/
export function SectionBlock({
  block,
  children,
}: {
  block: BlockInstance;
  children: ReactNode;
}) {
  const { maxWidth, paddingY, background, divider } = sectionLayout(block);
  return (
    <section
      className={`pp-section${divider ? ' pp-section-divided' : ''}`}
      style={{
        paddingTop: paddingY,
        paddingBottom: paddingY,
        background: background ?? undefined,
      }}
    >
      <div className="pp-section-inner" style={{ maxWidth: maxWidth ? `${maxWidth}px` : undefined }}>
        {children}
      </div>
    </section>
  );
}
```

`index.tsx` 鍒嗘淳閾惧湪 `grid` 涔嬪悗鍔?`section` 鍒嗘敮锛堟覆鏌?`visibleChildren`锛夈€?
`styles.css` 杩藉姞锛?
```css
.pp-section-inner { margin-inline: auto; width: 100%; }
.pp-section-divided { border-block: 1px solid var(--line); }
```

- [ ] **Step 4: 楠屾敹骞舵彁浜?*

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/blocks.ts apps/web/src/lib/sectionBlock.test.ts \
  apps/web/src/components/blocks/LayoutBlocks.tsx apps/web/src/components/blocks/index.tsx apps/web/src/styles.css
git commit -m "feat(web): add the section block"
```

---

