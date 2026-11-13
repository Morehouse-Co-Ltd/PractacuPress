### Task 5: media 灞炴€х被鍨嬩笌濯掍綋搴撻€夋嫨鍣?
鐜板湪鍥剧墖鍧楀彧鑳芥墜濉?URL锛坄blocks.ts:633`锛夈€侾0 璁?`image` 鐨?`src` 璧?`media` 绫诲瀷锛?琛ㄥ崟閲岃兘鐩存帴浠庡獟浣撳簱鎸戝浘銆?
**Files:**
- Modify: `apps/web/src/lib/blocks.ts`锛坄PropType` 澧?`'media'`锛沗image` 鐨?`src` 鏀圭被鍨嬶級
- Create: `apps/web/src/components/builder/MediaPicker.tsx`
- Modify: `apps/web/src/components/builder/BlockProps.tsx`
- Modify: `apps/web/src/lib/customize.ts`锛坄media` 鍊肩櫧鍚嶅崟锛氬彧鎺ュ彈 `/api/v1/media/鈥銆乣http(s)://`銆乣/鈥锛?- Test: `apps/web/src/lib/mediaProps.test.ts`锛堟柊寤猴級

**Interfaces:**
- Consumes: `normalizeBlockProps`锛圱ask 4锛夈€?- Produces: `PropType` 澧炲姞 `'media'`銆?- Produces: `<MediaPicker value={string} onChange={(url: string) => void} />`銆?- Produces: `normalizeMediaUrl(value: unknown): string | undefined`鈥斺€旈潪娉曞€硷紙鍚?`data:`锛夎繑鍥?`undefined`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/web/src/lib/mediaProps.test.ts`锛?
```ts
import { describe, expect, it } from 'vitest';
import { normalizeBlockProps, normalizeMediaUrl } from './customize';

describe('normalizeMediaUrl', () => {
  it('鎺ュ彈绔欏唴濯掍綋鍦板潃銆佺粷瀵?http(s) 涓庣珯鍐呰矾寰?, () => {
    expect(normalizeMediaUrl('/api/v1/media/abc')).toBe('/api/v1/media/abc');
    expect(normalizeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(normalizeMediaUrl('/img/a.png')).toBe('/img/a.png');
  });

  it('鎷掔粷 data URL銆乯avascript 涓庣浉瀵硅矾寰?, () => {
    expect(normalizeMediaUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(normalizeMediaUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeMediaUrl('img/a.png')).toBeUndefined();
    expect(normalizeMediaUrl('')).toBeUndefined();
  });
});

describe('image 鍖哄潡鐨?src', () => {
  it('璧?media 鐧藉悕鍗?, () => {
    const props = normalizeBlockProps('image', { src: 'data:image/png;base64,AAAA', alt: '鍥? });
    expect(props.src).toBeUndefined();
    expect(props.alt).toBe('鍥?);
  });
});
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
npx vitest run src/lib/mediaProps.test.ts
```

Expected: FAIL 鈥斺€?`normalizeMediaUrl` 鏈鍑猴紝涓?`data:` 鐩墠浼氳褰撲綔鏅€氬瓧绗︿覆鏀捐銆?
- [ ] **Step 3: blocks.ts 澧炲姞 media 绫诲瀷骞舵敼 image 鐨?src**

`PropType` union 杩藉姞涓€琛岋細

```ts
  /** 濯掍綋搴撻€夋嫨鍣細鍊煎彧鎺ュ彈绔欏唴濯掍綋鍦板潃銆乭ttp(s) 鎴?/ 寮€澶寸殑绔欏唴璺緞銆?*/
  | 'media';
```

鎶?`image` 鍖哄潡 schema 閲岀殑 `src` 椤规崲鎴愶細

```ts
      { key: 'src', label: t('鍥剧墖鍦板潃'), type: 'media', hint: t('鍙互浠庡獟浣撳簱閫夛紝涔熷彲浠ュ～澶栭儴鍥剧墖鍦板潃銆?) },
```

- [ ] **Step 4: customize.ts 鍔?normalizeMediaUrl 骞舵帴杩?props 娓呮礂**

鍦?`normalizeBlockProps` 涔嬪墠鎻掑叆锛?
```ts
/**
 * 濯掍綋鍦板潃鐧藉悕鍗曘€? *
 * 鍙帴鍙楃珯鍐呭獟浣撶鐐广€乭ttp(s) 缁濆鍦板潃涓?/ 寮€澶寸殑绔欏唴璺緞锛? * `data:` 涓?`javascript:` 涓€寰嬫嫆缁濃€斺€斿尯鍧楅噷鐨勫唴鑱斿浘鐗囦細鎶?1 MiB 鐨勮璁￠绠楃灛闂存拺鐖嗐€? */
export function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!url || url.length > 2048) return undefined;
  if (url.startsWith('/api/v1/media/') || url.startsWith('/')) return url.slice(0, 2048);
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2048);
  return undefined;
}
```

鍦?`normalizeBlockProps` 鐨勫瓧娈靛惊鐜噷锛宍repeater` 鍒嗘敮涔嬪墠鎻掑叆 media 鍒嗘敮锛?
```ts
    if (field.type === 'media') {
      const media = normalizeMediaUrl(source[field.key]);
      if (media) out[field.key] = media;
      continue;
    }
```

- [ ] **Step 5: 鍐?MediaPicker**

鏂板缓 `apps/web/src/components/builder/MediaPicker.tsx`锛?
```tsx
import { useEffect, useState } from 'react';
import type { Asset } from '../../types';
import { useBackend } from '../../lib/backend';
import { useT } from '../../lib/i18n';
import { Button, Modal } from '../ui';

/**
 * 濯掍綋搴撻€夋嫨鍣ㄣ€? *
 * 鍙垪宸叉壂鎻忛€氳繃锛坄scan_status === 'clean'`锛夌殑璧勪骇锛氭嫆缁濅笌寰呭鐨勮祫浜ц繛绠＄悊鍛? * 涔熶笉璇ユ嫋杩涚増闈€傝繑鍥炲€兼槸璧勪骇鐨勫睍绀哄湴鍧€锛屽尯鍧楅噷鍙瓨杩欎釜瀛楃涓层€? */
export function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError('');
    backend.api
      .listAssets()
      .then((items) => {
        if (!alive) return;
        setAssets(items.filter((asset) => asset.scan_status === 'clean' && asset.url));
      })
      .catch(() => {
        if (alive) setError(t('璇讳笉鍒板獟浣撳簱锛屾鏌ョ櫥褰曠姸鎬佹垨鍚庣鏄惁鍦ㄧ嚎銆?));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, backend, t]);

  return (
    <Modal open={open} title={t('浠庡獟浣撳簱閫夋嫨')} onClose={onClose}>
      {loading ? <p className="field-hint">{t('姝ｅ湪璇诲彇濯掍綋搴撯€?)}</p> : null}
      {error ? <p className="field-hint">{error}</p> : null}
      {!loading && !error && assets.length === 0 ? (
        <p className="field-hint">{t('濯掍綋搴撹繕鏄┖鐨勶紝鍏堝幓銆屽獟浣撱€嶉〉涓婁紶鍥剧墖銆?)}</p>
      ) : null}
      <div className="media-picker-grid">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            className="media-picker-item"
            onClick={() => {
              onPick(asset.url ?? '');
              onClose();
            }}
          >
            <img src={asset.url} alt={asset.file_name ?? ''} loading="lazy" />
            <span>{asset.file_name ?? asset.id}</span>
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={onClose}>
        {t('鍙栨秷')}
      </Button>
    </Modal>
  );
}
```

鍚屾椂鎶婁笅闈笁涓牱寮忚ˉ杩?`apps/web/src/styles.css`锛堟斁鍦?`.itemlist` 闄勮繎锛夛細

```css
.media-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; max-height: 320px; overflow: auto; margin: 12px 0; }
.media-picker-item { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-subtle); cursor: pointer; text-align: left; }
.media-picker-item img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; }
.media-picker-item span { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 6: BlockProps 娓叉煋 media 绫诲瀷**

鍦?`BlockProps.tsx` 鐨?`PropControl` 閲屽姞涓€涓垎鏀紙鏀惧湪 `repeater` 鍒嗘敮涔嬪悗锛夛細

```tsx
  if (schema.type === 'media') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <div className="media-field">
          <Input
            id={id}
            value={String(block.props[schema.key] ?? '')}
            onChange={(event) => onChange(schema.key, event.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
            {t('浠庡獟浣撳簱閫夋嫨')}
          </Button>
        </div>
        <MediaPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={(url) => onChange(schema.key, url)}
        />
      </Field>
    );
  }
```

`PropControl` 椤堕儴鍔犵姸鎬侊細`const [pickerOpen, setPickerOpen] = useState(false);`锛?骞舵妸 `useState` 鍔犺繘 react import锛沗MediaPicker` 涓庝細璇濈骇鐨?`Button` 涓€璧?import銆?鏍峰紡琛ヤ竴鏉★細

```css
.media-field { display: flex; gap: 8px; align-items: center; }
.media-field input { flex: 1; }
```

- [ ] **Step 7: 璺戞祴璇曚笌绫诲瀷妫€鏌?*

```bash
npx vitest run src/lib/mediaProps.test.ts && npm run typecheck
```

Expected: 鍏?PASS锛? 绫诲瀷閿欒銆?
- [ ] **Step 8: 鎻愪氦**

```bash
git add apps/web/src/lib/blocks.ts apps/web/src/lib/customize.ts \
  apps/web/src/components/builder/MediaPicker.tsx apps/web/src/components/builder/BlockProps.tsx \
  apps/web/src/lib/mediaProps.test.ts apps/web/src/styles.css
git commit -m "feat(web): add the media property type and a media library picker"
```

---

