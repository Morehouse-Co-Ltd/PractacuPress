### Task 4: PropSchema v2 涓?repeater 灞炴€?
鐜版湁 `itemlist` 鎶婄粨鏋勫寲鏁版嵁瀛樻垚 JSON 瀛楃涓层€佹瘡鏉″€兼埅 200 瀛楋紙`blocks.ts:1073-1092`锛夈€?瀛愬瓧娈靛彧鏈?text/color/select銆侾0 寮曞叆 `repeater`锛氬€煎氨鏄湡姝ｇ殑鏁扮粍锛屽瓙瀛楁澶嶇敤 `PropSchema`锛?褰掍竴鍖栨寜瀛?schema 閫掑綊鐧藉悕鍗曘€?
**Files:**
- Modify: `apps/web/src/types.ts`锛坄BlockPropValue`锛?- Modify: `apps/web/src/lib/blocks.ts:22-55,907-967`锛坄PropType`銆乣PropSchema`銆乣button` 鍖哄潡瀹氫箟锛?- Modify: `apps/web/src/lib/customize.ts`锛堟寜 schema 閫掑綊娓呮礂 props锛?- Modify: `apps/web/src/components/builder/BlockProps.tsx`锛坮epeater 琛ㄥ崟锛?- Test: `apps/web/src/lib/repeaterProps.test.ts`锛堟柊寤猴級

**Interfaces:**
- Produces: `type BlockPropValue = string | number | boolean | BlockPropRecord | BlockPropRecord[]`锛?  `type BlockPropRecord = Record<string, string | number | boolean>`鈥斺€?  `BlockInstance.props: Record<string, BlockPropValue>`銆?- Produces: `PropSchema.itemSchema?: PropSchema[]`銆乣minItems?: number`銆?  `maxItems?: number`銆乣itemLabel?: string`锛沗PropType` 澧炲姞 `'repeater'`銆?- Produces: `normalizeBlockProps(type: string, value: unknown): Record<string, BlockPropValue>`鈥斺€?  鎸夋敞鍐岃〃 schema 閫掑綊鐧藉悕鍗曟竻娲楋紝渚?`normalizeBlock` 璋冪敤涓庢祴璇曠洿鎺ヤ娇鐢ㄣ€?- Produces: `blockPropRecord(block, key): BlockPropRecord[]`鈥斺€旀覆鏌撳櫒璇?repeater 鍊肩殑鍞竴鍏ュ彛
  锛堝潖鍊间竴寰嬭繑鍥?`[]`锛夈€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/repeaterProps.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

describe('normalizeBlockProps', () => {
  it('repeater 鍊兼寜 itemSchema 閫掑綊娓呮礂锛屾湭澹版槑鐨勯敭琚涪寮?, () => {
    const props = normalizeBlockProps('button', {
      buttons: [{ label: '鍘?, link: '/a', style: 'solid', __evil: '<script>' }],
      unknown_top: 'drop me',
    });
    expect(props.buttons).toEqual([{ label: '鍘?, link: '/a', style: 'solid' }]);
    expect(props.unknown_top).toBeUndefined();
  });

  it('repeater 瓒呭嚭 maxItems 鐨勯儴鍒嗚鎴帀', () => {
    const buttons = Array.from({ length: 9 }, (_, i) => ({ label: `b${i}`, link: '/' }));
    const props = normalizeBlockProps('button', { buttons });
    expect((props.buttons as unknown[]).length).toBe(4);
  });

  it('闈炴暟缁勭殑 repeater 鍊煎洖閫€鎴愮┖鏁扮粍', () => {
    const props = normalizeBlockProps('button', { buttons: 'not-an-array' });
    expect(props.buttons).toBeUndefined();
  });

  it('鏃ч厤缃噷鐨?itemlist JSON 瀛楃涓蹭粛鐒惰兘璇绘垚 repeater 鍊?, () => {
    const props = normalizeBlockProps('button', {
      buttons: JSON.stringify([{ label: '鏃ф寜閽?, link: '/old' }]),
    });
    expect(props.buttons).toEqual([{ label: '鏃ф寜閽?, link: '/old', style: '' }]);
  });

  it('涓嶈璇嗙被鍨嬬殑 props 鍘熸牱淇濈暀鏍囬噺', () => {
    expect(normalizeBlockProps('pricing-v9', { plan: 'A', n: 1 })).toEqual({ plan: 'A', n: 1 });
  });
});

describe('createBlock', () => {
  it('button 鐨勯粯璁?props 鏄┖ repeater 鑰屼笉鏄?JSON 瀛楃涓?, () => {
    expect(createBlock('button').props.buttons).toEqual([]);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/repeaterProps.test.ts
```

Expected: FAIL 鈥斺€?`normalizeBlockProps` 鏈鍑猴紱`buttons` 鎷垮埌鐨勬槸瀛楃涓层€?
- [ ] **Step 3: 鍦?types.ts 鏀惧 props 鐨勫€肩被鍨?*

鍦?`apps/web/src/types.ts` 鐨?`BlockInstance` 瀹氫箟涔嬪墠鎻掑叆锛?
```ts
/** 涓€涓?repeater 鏉＄洰锛氬彧鍏佽鏍囬噺涓庡瓧绗︿覆銆?*/
export type BlockPropRecord = Record<string, string | number | boolean>;

/** 鍖哄潡灞炴€у€硷細鏍囬噺鎴?repeater 鐨勬潯鐩暟缁勩€?*/
export type BlockPropValue = string | number | boolean | BlockPropRecord[];

export type BlockProps = Record<string, BlockPropValue>;
```

鎶?`BlockInstance` 閲岀殑 `props: Record<string, string | number | boolean>;` 鏀规垚锛?
```ts
  props: BlockProps;
```

- [ ] **Step 4: 鎵╁睍 blocks.ts 鐨?schema 绫诲瀷**

鎶?`apps/web/src/lib/blocks.ts` 鐨?`PropType` 涓?`PropSchema`锛?2-44 琛岋級鏇挎崲涓猴細

```ts
export type PropType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'toggle'
  | 'color'
  /** 鏃х殑缁撴瀯鍖栧垪琛細JSON 瀛楃涓层€傚彧涓鸿鍙栨棦鏈夐厤缃繚鐣欍€?*/
  | 'itemlist'
  /** 缁撴瀯鍖栧垪琛細鍊兼槸鏉＄洰鏁扮粍锛屽瓙瀛楁鐢?itemSchema 閫掑綊澹版槑銆?*/
  | 'repeater';

export interface PropSchema {
  key: string;
  label: string;
  type: PropType;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** itemlist锛氭潯鐩瓧娈碉紝渚嬪 [{ key: 'label', label: '鍚嶇О' }] */
  itemFields?: {
    key: string;
    label: string;
    type?: 'text' | 'color' | 'select';
    options?: { value: string; label: string }[];
  }[];
  itemLabel?: string;
  maxItems?: number;
  /** repeater锛氭瘡涓潯鐩殑瀛楁锛屽鐢ㄥ悓涓€濂?PropSchema锛堜笉鍏佽鍐嶅祵 repeater锛夈€?*/
  itemSchema?: PropSchema[];
  minItems?: number;
}
```

- [ ] **Step 5: 鎶?button 鍖哄潡杩佸埌 repeater**

鎵惧埌 `blocks.ts` 閲?`type: 'button'` 鐨勫畾涔夛紙鍘?907 琛岄檮杩戯級锛屾妸瀹冪殑 `defaults` 涓?`schema` 鎹㈡垚锛?
```ts
    defaults: { buttons: [], align: 'left', size: 'md', new_tab: false },
    schema: [
      {
        key: 'buttons',
        label: t('鎸夐挳'),
        type: 'repeater',
        itemLabel: t('鎸夐挳'),
        minItems: 1,
        maxItems: 4,
        hint: t('鏈€澶?4 涓紱閾炬帴鍙帴鍙?http(s) 鍦板潃鎴?/ 寮€澶寸殑绔欏唴璺緞銆?),
        itemSchema: [
          { key: 'label', label: t('鏂囧瓧'), type: 'text' },
          { key: 'link', label: t('閾炬帴'), type: 'text' },
          {
            key: 'style',
            label: t('鏍峰紡'),
            type: 'select',
            options: [
              { value: 'solid', label: t('瀹炲績') },
              { value: 'outline', label: t('鎻忚竟') },
              { value: 'ghost', label: t('骞界伒') },
              { value: 'link', label: t('鏂囧瓧閾?) },
            ],
          },
        ],
      },
      {
        key: 'align',
        label: t('瀵归綈'),
        type: 'select',
        options: [
          { value: 'left', label: t('宸?) },
          { value: 'center', label: t('涓?) },
          { value: 'right', label: t('鍙?) },
        ],
      },
      {
        key: 'size',
        label: t('灏哄'),
        type: 'select',
        options: [
          { value: 'sm', label: t('灏?) },
          { value: 'md', label: t('涓?) },
          { value: 'lg', label: t('澶?) },
        ],
      },
      { key: 'new_tab', label: t('鍦ㄦ柊绐楀彛鎵撳紑'), type: 'toggle' },
    ],
```

- [ ] **Step 6: 鍦?customize.ts 鍐?normalizeBlockProps**

鍦?`apps/web/src/lib/customize.ts` 鐨?`normalizeBlock` 涔嬪墠鎻掑叆锛?
```ts
function scalarValue(item: unknown): string | number | boolean | undefined {
  if (typeof item === 'number') return Math.min(1e6, Math.max(-1e6, item));
  if (typeof item === 'boolean') return item;
  if (typeof item === 'string') return item.slice(0, 4000);
  return undefined;
}

function normalizePropRecord(
  value: unknown,
  schema: PropSchema[],
): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const field of schema) {
    const raw = source[field.key];
    if (field.type === 'repeater') continue; // 鍙厑璁镐竴灞?    const scalar = scalarValue(raw);
    if (scalar !== undefined) out[field.key] = scalar;
  }
  return out;
}

function normalizeRepeaterValue(
  value: unknown,
  schema: PropSchema,
): Record<string, string | number | boolean>[] | undefined {
  const fields = schema.itemSchema ?? [];
  const max = schema.maxItems ?? 30;
  let list: unknown[] | null = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value) {
    // 鏃ч厤缃細itemlist 瀛樼殑灏辨槸 JSON 瀛楃涓层€?    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = null;
    }
  }
  if (!list) return undefined;
  const out = list
    .slice(0, max)
    .map((item) => normalizePropRecord(item, fields))
    .filter((item): item is Record<string, string | number | boolean> => !!item);
  return out.length ? out : undefined;
}

/**
 * 鎸夋敞鍐岃〃 schema 閫掑綊鐧藉悕鍗曟竻娲楀睘鎬с€? *
 * 鏈湪 schema 閲屽０鏄庣殑閿竴寰嬩涪寮冣€斺€旀湇鍔＄鍙瓨涓嶈В閲婏紝鐧藉悕鍗曞彧鑳藉湪鍓嶇杩欎竴灞傚仛銆? * 涓嶈璇嗙殑鍖哄潡绫诲瀷閫€鍖栨垚"鍙繚鐣欐爣閲?锛屼繚璇佷粠鏇存柊鐗堟湰瀵煎叆鐨勯厤缃笉浼氫涪鍐呭銆? */
export function normalizeBlockProps(
  type: string,
  value: unknown,
): Record<string, BlockPropValue> {
  const def = blockDef(type);
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!def) {
    const out: Record<string, BlockPropValue> = {};
    for (const [key, item] of Object.entries(source)) {
      const scalar = scalarValue(item);
      if (scalar !== undefined) out[key] = scalar;
    }
    return out;
  }
  const out: Record<string, BlockPropValue> = {};
  for (const field of def.schema) {
    if (field.type === 'repeater') {
      const list = normalizeRepeaterValue(source[field.key], field);
      if (list) out[field.key] = list;
      continue;
    }
    const scalar = scalarValue(source[field.key]);
    if (scalar !== undefined) out[field.key] = scalar;
  }
  return out;
}

/** 璇?repeater 鍊硷紱鍧忔暟鎹竴寰嬭繑鍥炵┖鏁扮粍锛屾覆鏌撳櫒涓嶉渶瑕侀槻寰°€?*/
export function blockPropRecord(
  block: Pick<BlockInstance, 'props'>,
  key: string,
): Record<string, string | number | boolean>[] {
  const value = block.props[key];
  return Array.isArray(value) ? value : [];
}
```

鎶?`normalizeBlock` 閲屾瀯閫?`props` 鐨勯偅娈靛惊鐜細

```ts
  const props: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw.props ?? {})) {
    // 鈥?  }
```

鏁翠綋鏇挎崲涓轰竴琛岋細

```ts
  const props = normalizeBlockProps(raw.type, raw.props);
```

椤堕儴 import 琛ヤ笂 `PropSchema`銆乣BlockPropValue` 绫诲瀷涓?`blockDef`锛堣嫢灏氭湭寮曞叆锛夈€?
- [ ] **Step 7: BlockProps.tsx 鏀寔 repeater**

鍦?`apps/web/src/components/builder/BlockProps.tsx` 鐨?`PropControl` 閲岋紝
`if (schema.type === 'itemlist')` 鍒嗘敮涔嬪墠鎻掑叆锛?
```tsx
  if (schema.type === 'repeater') {
    const items = blockPropRecord(block, schema.key);
    const max = schema.maxItems ?? 30;
    const min = schema.minItems ?? 0;
    const commit = (next: Record<string, string | number | boolean>[]) =>
      onChange(schema.key, next.slice(0, max));

    return (
      <Field
        label={schema.label}
        hint={schema.hint ?? t('鏈€澶?{count} 鏉°€?, { count: max })}
        aside={`${items.length}/${max}`}
      >
        <div className="itemlist">
          {items.map((item, index) => (
            <div className="itemlist-row" key={index}>
              {(schema.itemSchema ?? []).map((field) => {
                const update = (value: string | number | boolean) => {
                  commit(items.map((entry, i) => (i === index ? { ...entry, [field.key]: value } : entry)));
                };
                return (
                  <label key={field.key} className="itemlist-field">
                    <span>{field.label}</span>
                    {field.type === 'select' ? (
                      <select
                        value={String(item[field.key] ?? '')}
                        onChange={(event) => update(event.target.value)}
                        aria-label={`${schema.label} 绗?${index + 1} 鏉?${field.label}`}
                      >
                        <option value="">鈥?/option>
                        {(field.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : field.type === 'toggle' ? (
                      <input
                        type="checkbox"
                        checked={item[field.key] === true}
                        onChange={(event) => update(event.target.checked)}
                        aria-label={`${schema.label} 绗?${index + 1} 鏉?${field.label}`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={String(item[field.key] ?? '')}
                        onChange={(event) => update(event.target.value)}
                        aria-label={`${schema.label} 绗?${index + 1} 鏉?${field.label}`}
                      />
                    )}
                  </label>
                );
              })}
              <button
                type="button"
                className="link-btn"
                disabled={items.length <= min}
                onClick={() => commit(items.filter((_, i) => i !== index))}
              >
                {t('鍒犻櫎')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={items.length >= max}
            onClick={() => {
              const blank: Record<string, string | number | boolean> = {};
              for (const field of schema.itemSchema ?? []) {
                blank[field.key] = field.type === 'toggle' ? false : '';
              }
              commit([...items, blank]);
            }}
          >
            {t('娣诲姞{label}', { label: schema.itemLabel ?? t('鏉＄洰') })}
          </button>
        </div>
      </Field>
    );
  }
```

椤堕儴 import 鏀规垚锛?
```tsx
import { blockDef, blockProp, type PropSchema } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
```

骞舵妸 `PropControl` 涓?`BlockProps` 鐨勫洖璋冪鍚嶇粺涓€鎴?`(key: string, value: BlockPropValue)` / `(props: BlockProps)`锛堜粠 `../../types` 寮曞叆锛夈€?
- [ ] **Step 8: 璁╂覆鏌撳櫒璇?button 鐨勬柊褰㈢姸**

鍦?`apps/web/src/components/blocks/ActionBlocks.tsx` 閲岋紝鎶婅鍙?`props.buttons`
鐨?JSON 瑙ｆ瀽鏀规垚 `blockPropRecord(block, 'buttons')`锛?
```tsx
  const buttons = blockPropRecord(block, 'buttons');
```

淇濈暀鍘熸湁鐨勯摼鎺ョ櫧鍚嶅崟涓?`aria-disabled` 閫昏緫涓嶅彉锛涘彧鏇挎崲鍙栧€兼柟寮忋€?
- [ ] **Step 9: 璺戞祴璇曘€佺被鍨嬫鏌ヤ笌鍏ㄩ噺鍥炲綊**

```bash
npx vitest run src/lib/repeaterProps.test.ts && npm run typecheck && npx vitest run
```

Expected: 鍏ㄩ儴 PASS锛沗typecheck` 0 閿欒锛坄BlockProps` 鏀惧鍚庣殑绫诲瀷浼氱壍鍔?`BlockInspector.tsx` 鐨?patch 绛惧悕锛屽鎶ラ敊灏卞悓姝ユ敼鎴?`BlockProps`锛夈€?
- [ ] **Step 10: 鎻愪氦**

```bash
git add apps/web/src/types.ts apps/web/src/lib/blocks.ts apps/web/src/lib/customize.ts \
  apps/web/src/components/builder/BlockProps.tsx apps/web/src/components/blocks/ActionBlocks.tsx \
  apps/web/src/components/builder/BlockInspector.tsx apps/web/src/lib/repeaterProps.test.ts
git commit -m "feat(web): add repeater property schema and migrate the button block to it"
```

---

