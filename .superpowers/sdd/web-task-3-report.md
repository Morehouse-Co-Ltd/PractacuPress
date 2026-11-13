# Web Task 3 report — model v2 fields + `schema_version` + v1→v2 migrator

Status: **DONE_WITH_CONCERNS**
Branch: `feat/page-builder-v2-p0`
Commit: `3ec5f8a` — `feat(web): add schema v2 block fields, version stamp and the v1 to v2 migrator`
Staged paths (only these): `apps/web/src/types.ts`, `apps/web/src/lib/migrate.ts`, `apps/web/src/lib/migrate.test.ts`,
`apps/web/src/lib/customize.ts`, `apps/web/src/lib/screenLayout.test.ts`

## 0. Source of truth used

`.superpowers/sdd/web-task-3-brief.md` is **double-encoded mojibake** (UTF-8 text stored as UTF-8-of-GBK), so every
Chinese string in it is unreadable and a handful of characters are lost (`�?`). The same plan text exists intact in
`docs/superpowers/plans/2026-11-02-page-builder-v2-p0-web.md`, lines **410–724** ("Task 3: 模型 v2 字段 + schema_version
+ 迁移器"), which I used as the verbatim source. Repair recipe for the record (PowerShell):

```powershell
$s = [IO.File]::ReadAllText($brief, [Text.Encoding]::UTF8)
$fixed = [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(936).GetBytes($s))
```

No line number from the brief was trusted; every anchor was matched on the quoted code. Actual current locations
(after this commit): `SitePage` types.ts:529, `BlockInstance` types.ts:827, `unsupported?: boolean` types.ts:856,
`SiteCustomization.language` types.ts:1008, `normalizeBlock` customize.ts:674, `normalizeScreenLayout`
customize.ts:782, `readCustomization` customize.ts:897.

## 1. `apps/web/src/types.ts`

Inserted **before `SitePage`** (verbatim from the plan): `BlockSpan`, `BlockDisplayOverride`, `BlockVisibility`.
Appended to `BlockInstance` after `unsupported?: boolean;` (verbatim): `at`, `visible`, `anchor`, `span`, `offset`.
Added to `SiteCustomization` after `language?: Locale;` (verbatim):

```ts
  /** 设计文档的结构版本；缺省按 1 处理，读入时由 migrate.ts 升级到 2。 */
  schema_version?: number;
```

**One deliberate change to a quoted value**: `BlockDisplayOverride` is wrapped in `Partial<…>`.

```ts
export type BlockDisplayOverride = Partial<
  Pick<BlockInstance, 'span' | 'appearance' | 'animation' | 'hidden' | 'custom_css' | 'width' | 'height'>
> & { align?: …; gap_scale?: number; mt?: number; mb?: number };
```

Reason (hard evidence, not taste): the plan's literal `Pick<…>` copies `hidden` and `animation` as **required**
(they are required on `BlockInstance`; `Pick` preserves modifiers). `tsc --noEmit` rejected the first implementation
with `src/lib/customize.ts(594,9): error TS2322: Type '{}' is not assignable to type 'BlockDisplayOverride' … missing
the following properties … hidden, animation`. Semantically an `at` entry is a *diff* patch (the plan's own test 3
expects `at` to equal exactly `{ mobile: { hidden: true } }`), so it must be partial. Leaving it required would also
make every P1 consumer believe `override.hidden` is always defined.

## 2. `apps/web/src/lib/migrate.ts` (new, 138 lines)

Implements `CURRENT_SCHEMA_VERSION = 2`, `MigrationResult`, `sameShape`, `diffDisplay`, `foldDisplay`, `foldLayout`,
`migrateCustomization` — same structure and same user-facing Chinese wording as the plan, with the reconciliations in
§5. Purity: the incoming document is only ever copied (`{ ...raw }`, `{ ...layout.devices }`, `structuredClone` of the
block trees); the folded trees live on clones, so the caller's object is never mutated. Idempotence: after the first
pass `schema_version === 2`, and the second pass returns early with `report: []`.

## 3. `apps/web/src/lib/customize.ts`

- `import { migrateCustomization } from './migrate';`
- `readCustomization` now migrates first, and reads the migrated document:

```ts
export function readCustomization(config: Pick<WebConfig, 'customization'>): SiteCustomization {
  if (!config.customization) return DEFAULT_CUSTOMIZATION;
  // 只改读取路径：v1 的三棵树在这里折算成 v2 的展示层覆盖，保存路径仍然写原始对象，
  // 迁移结果在下一次保存（或 customizationSync 的本地缓存写回）时自然落盘。
  const raw = migrateCustomization(config.customization).value as Partial<SiteCustomization>;
  …
```

  The existing `if (!raw) return DEFAULT_CUSTOMIZATION;` guard was kept (moved above the migration) instead of being
  dropped: `migrateCustomization(undefined)` returns `{}`, and switching the guard to `!raw` would have made the
  "no customization at all" path fall through into full normalization and stop returning `DEFAULT_CUSTOMIZATION`.
  Signature left as `Pick<WebConfig, 'customization'>` (the plan's snippet wrote `WebConfig`; the real signature is
  narrower and every call site — `customizationSync.ts:185`, `visitorBootstrap.ts`, `extensions.ts`, `main.tsx` — passes
  just that).
- **Added** a private read-path cleaner for the v2 fields (`plainRecord`, `clampSpan`, `normalizeBlockSpan`,
  `normalizeDisplayOverride`, `normalizeBlockAt`, `normalizeBlockVisibility`, `blockDisplayFields`) and spread
  `...blockDisplayFields(raw)` into **both** `normalizeBlock` return branches. See §5.4 — without it the whole migration
  is a no-op in the read path and the folded overrides are destroyed on the next save. `SPAN_MIN/SPAN_MAX = 1/12`,
  appearance via the existing `normalizeBlockAppearance`, `custom_css`/`width`/`height` reuse the same caps as the
  base block (`4000` / `1600` / `2400`).

## 4. `apps/web/src/lib/migrate.test.ts` (new, 8 tests)

The plan's 5 cases verbatim, plus 3 that pin requirements stated outside the snippet:

- `不修改调用方传进来的文档（纯函数）` — `structuredClone` snapshot before/after.
- `对迁移结果再跑一次不产生任何变化（幂等）` — second pass: same value, empty report.
- `结构相同但没有任何展示差异的设备直接丢掉、不谎报结构不同` — see §5.1.

## 5. Deliberate reconciliations (the plan contradicts itself / loses data in three places)

### 5.1 Report sentence names the devices (plan's own test could not pass otherwise)

Plan code: `if (folded) report.push(`${label}：已把 ${folded} 端与桌面不同的展示设置折算成覆盖。`)`.
Plan test 3 then asserts `expect(report.join('')).toContain('手机')` — with the plan's sentence the folded case yields
`首页：已把 1 端与桌面不同的展示设置折算成覆盖。`, which contains **no** `手机`. Kept the wording and the intent, but
collected the device labels instead of a counter:

```ts
if (folded.length) report.push(`${label}：已把${folded.join('、')}端与桌面不同的展示设置折算成覆盖。`);
// 首页：已把手机端与桌面不同的展示设置折算成覆盖。
```

Same fix removes a second, worse wart: a device tree with an **identical** structure and **no** display difference
returned `false` from `foldDisplay` and was therefore reported as `布局与桌面结构不同` — a lie, and it kept a redundant
identical tree. The loop now distinguishes the two cases (structure differs → `kept` + report; structure same →
fold the diff if any, then drop the redundant copy silently). The kept-branch sentence, including `结构不同`, is
unchanged, so plan test 4 still passes.

### 5.2 No integer counter

`let folded = 0` became `const folded: string[] = []` because the message now names devices (§5.1). `kept` is
unchanged.

### 5.3 `sameShape` hardened against garbage

`sameShape`/`foldDisplay` walk the raw document *before* the normalizer's depth/type clamping, so `a[i].id` on `null`
or `children: "x"` would throw. Added `childrenOf()` (non-array `children` → `[]`) and typeof guards, so
`migrateCustomization` cannot throw on structurally bad input. The plan's own `坏数据不抛异常` case only covers `null`
and `{ home: 'nope' }`.

### 5.4 `normalizeBlock` now preserves the v2 fields (else the migration silently destroys layout)

This is the one real behavioural addition beyond the two listed files, and it is required for the task to be correct:
`normalizeBlock` builds blocks from an explicit whitelist, so `at`/`visible`/`anchor`/`span`/`offset` were dropped the
moment `readCustomization` normalized the migrated document. Concretely, for a v1 config with a mobile-only `hidden`
block: migration folds it into `at.mobile`, and `normalizeBlock` then threw the `at` away — while the mobile tree itself
had already been folded away, so the user's mobile-only setting was gone forever after the next save
(`customizationSync` writes `readCustomization()`'s output into the local cache; `useCustomization().update` spreads it
back into the config). That is exactly the "silently change someone's layout" class of bug the brief warns about.

Verification that this is real (removed the spread, ran the new test):

```
 ❯ src/lib/screenLayout.test.ts:99:45
AssertionError: expected undefined to equal { mobile: { hidden: true } }
+ Received: undefined
```

`apps/web/src/lib/screenLayout.test.ts` is therefore the fifth staged file: one stale assertion updated + one test
added.

- Stale assertion: `expect(customization.home.devices?.desktop?.blocks[0].title).toBe('桌面文案')`. That test feeds a
  **v1** config (`schema_version` absent), and v2 semantics deliberately drop the desktop copy when it is structurally
  identical to `blocks` (the plan's own `if (devices.desktop && sameShape(...)) delete devices.desktop;`). It now asserts
  `devices.desktop` is `undefined`, `home.blocks[0].title === '桌面文案'` (the desktop view falls back to `blocks`), and
  keeps the mobile-tree assertion, which is the part that must survive. Its title/intent (`保留 device_split 与各设备编排`)
  still holds for the device that was **not** folded.
- New test `迁移折算出来的 at 经过归一化仍然保留` — desktop+mobile with the same shape, mobile `hidden: true` →
  `blocks[0].at` equals `{ mobile: { hidden: true } }`, `device_split`/`devices` gone.

No other existing assertion regressed (see §7).

## 6. Red / green evidence (run from `apps/web`)

### Red 1 — migrator does not exist
`npx vitest run src/lib/migrate.test.ts`

```
 FAIL  src/lib/migrate.test.ts [ src/lib/migrate.test.ts ]
Error: Failed to resolve import "./migrate" from "src/lib/migrate.test.ts". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

(The plan expected `Cannot find module './migrate'`; same failure, Vite's resolver wording.)

### Green 1
`npx vitest run src/lib/migrate.test.ts`

```
 ✓ src/lib/migrate.test.ts (5 tests) 5ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Red 2 — read path changed under a stale test
`npx vitest run` (full suite, right after wiring `readCustomization`)

```
 ✓ src/lib/migrate.test.ts (5 tests) 9ms
 ❯ src/lib/screenLayout.test.ts (6 tests | 1 failed) 19ms
   × 按设备选择页面编排 > 配置归一化保留 device_split 与各设备编排 13ms
     → expected undefined to be '桌面文案' // Object.is equality
 Test Files  1 failed | 47 passed (48)
      Tests  1 failed | 534 passed (535)
```

### Red 3 — folded `at` dies in normalization (proved by temporarily removing the spread)
`npx vitest run src/lib/screenLayout.test.ts`

```
 ❯ src/lib/screenLayout.test.ts:99:45
AssertionError: expected undefined to equal { mobile: { hidden: true } }
+ Received: undefined
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

### Green 2 — restored
`npx vitest run src/lib/migrate.test.ts src/lib/screenLayout.test.ts`

```
 ✓ src/lib/migrate.test.ts (8 tests) 11ms
 ✓ src/lib/screenLayout.test.ts (7 tests) 12ms
 Test Files  2 passed (2)
      Tests  15 passed (15)
```

## 7. Final verification

```
npx vitest run
 Test Files  48 passed (48)
      Tests  539 passed (539)
   Duration  44.89s
npm run typecheck   # tsc --noEmit
(no output, exit 0)
```

539 = 530 baseline + 8 migrator tests + 1 new screenLayout test. Nothing outside the five paths was staged, added,
stashed or reverted; `git add -A` / `git commit -a` were never used; my five paths were clean before I edited them
(verified with `git status --short`), so the commit contains only this task's work.

## 8. Concerns / things noticed

1. **`schema_version` never reaches storage.** `readCustomization` returns a `SiteCustomization` that has no
   `schema_version` key, and that return value is what `customizationSync` caches and what `useCustomization().update`
   spreads into the saved config. So the folded *structure* does persist, but the version stamp does not: every load
   re-runs the v1→v2 pass (idempotent, no structural change) and regenerates `report`. Consequences: (a) the plan's
   "迁移结果在下一次保存时自然落盘" is only half true; (b) a permanently-kept structurally-different device tree will be
   reported on every read — arguably desirable, but it should be a conscious decision. Fix would be one line
   (`schema_version: CURRENT_SCHEMA_VERSION` in the returned literal) but it changes `readCustomization`'s output shape,
   which the brief did not authorize, so I did not do it.
2. **`report` is currently thrown away.** `migrateCustomization`'s `report` is the user-facing Chinese explanation, but
   `readCustomization` discards it (`migrateCustomization(...).value`). Surfacing it needs the caller to ask for the
   whole `MigrationResult` — either a new `readCustomizationReport`/`migrateOnly` seam or returning it from
   `readCustomization` — which no P0 task appears to own yet. Worth pinning before the UI task.
3. **`structuredClone` is used for the first time in `src/`** (the codebase's own deep clone, `blocks.ts` `cloneBlocks`,
   is `JSON.parse(JSON.stringify(...))`). The migrator's input is JSON by contract, so either would work here; the plan
   prescribed `structuredClone`, and it is available in the test env (Node 24 + happy-dom) and in browsers ≥ 2022
   (Chrome 98 / Safari 15.4 / Firefox 94). Flagging only because it raises the minimum browser baseline slightly.
4. **Recursion has no depth cap.** `sameShape` / `foldDisplay` recurse over the raw document, which arrives *before*
   `normalizeBlock`'s `MAX_BLOCK_DEPTH` clamp. A pathologically deep JSON document (imported file) could exhaust the
   stack. Not reachable through the UI (depth is capped at read time) and not covered by any P0 test; a `depth > 32 →
   false` guard would close it if you want it.
5. **Interaction with Task 4.** Task 4 is scheduled to rewrite `normalizeBlock`'s props loop and insert
   `normalizeBlockProps` immediately before `normalizeBlock`. My `blockDisplayFields(raw)` spread sits at the end of both
   return branches, i.e. after that insertion point; rebasing Task 4 over this commit should be mechanical, but the
   `...(appearance ? { appearance } : {})` anchor it ends on is the same one Task 4 rewrites.
6. **`hidden` is now stored twice for folded blocks** (`hidden` on the base block + `at.mobile.hidden`). That is exactly
   the v2 model the plan asks for, but P1 must remember that the *base* value wins for desktop while `at` only applies
   to the overridden device — the renderer task should read `area`-style fallbacks off the device, not overlay `at`
   unconditionally.
7. `.superpowers/sdd/web-task-3-brief.md` should be re-encoded (see §0); every downstream task reading it will hit the
   same mojibake, and the `�?` losses make at least one quoted template string look syntactically broken
   (`` `${label}�?{kept.join('�?)}` ``), which invites someone to "fix" it into a different sentence.

## Fix: 迁移落盘与递归上限

Two review findings, both closed. Staged paths: `apps/web/src/lib/migrate.ts`,
`apps/web/src/lib/migrate.test.ts`, `apps/web/src/lib/customize.ts` (exact paths only; no `git add -A`).

### A. 版本印记随读入结果返回（迁移不再每次重跑）

`customize.ts`: `import { CURRENT_SCHEMA_VERSION, migrateCustomization } from './migrate';`, and `readCustomization`'s
returned literal now starts with

```ts
    // 结构版本随读入结果一起返回：它就是让迁移器下次读取直接返回、不再重跑的印记。
    schema_version: CURRENT_SCHEMA_VERSION,
```

Because `customizationSync` caches this value and `useCustomization().update` spreads it back, the stamp now reaches
storage, so the next read short-circuits in `migrateCustomization` (`version >= CURRENT_SCHEMA_VERSION`) instead of
re-folding v1 trees and regenerating `report` (concern #1 of the previous round).

### B. 递归有了上限

`migrate.ts`: `import { MAX_BLOCK_DEPTH } from './blockTree';`
(`MAX_BLOCK_DEPTH = 8`). `sameShape(a, b, depth = 0)` and `foldDisplay(base, other, device, depth = 0)` now begin with
`if (depth >= MAX_BLOCK_DEPTH) return false;` — "cannot prove these are the same shape" → the device tree is kept
instead of folded, the safe direction. `sameShape` passes `depth + 1` down, and `foldDisplay`'s inner `walk` carries
`level` (same guard) so the raw document is never walked unbounded. `foldLayout` still calls
`foldDisplay(..., device)` / `sameShape(...)`, i.e. depth defaults to 0 at the entry points.

### C. One additional line inside the allowed files, forced by A's idempotence test

The mandated second-read `toEqual` exposed a pre-existing asymmetry in the read path: `normalizeTaxonomy` falls back to
`DEFAULT_TAXONOMY` **without** running the terms through `normalizeTerm`, and the five default tags had no `description`
key while `normalizeTerm` always emits `description: ''`. So read #1 produced tags without `description`, read #2 added
it, and the entry point was not idempotent. Fixed at the source of the asymmetry (the default data):

```ts
  tags: [
    // 默认词条与 normalizeTerm 的输出保持同一形状（空说明也显式写出来），
    // 否则第一次读入补上 description、第二次读入才稳定，读取路径就不可幂等。
    { id: 'tag_independent', name: '独立出版', slug: 'independent', description: '' },
    …
```

No other file touched; no consumer changes (`description` is optional on `TaxonomyTerm`, `''` is as falsy as absent).

### D. New tests (`migrate.test.ts`, 8 → 10)

- `嵌套远超深度上限时不爆栈，并保留设备编排` — a 40-deep `children` chain (`chain(40)` helper) used for **both**
  `blocks` and `devices.mobile.blocks`, so the shape comparison really recurses; asserts `not.toThrow()` and
  `home.devices.mobile` still defined. Without the depth guard `sameShape` would return `true`, `foldLayout` would drop
  the redundant mobile copy, and the assertion would fail — the test pins the guard, not just "empty base vs deep tree".
- `describe('迁移结果落盘')` → `读入时带上版本号，再读一次不再重跑迁移` — builds the brief's minimal `WebConfig`
  (`{ version: 1, setup_complete: true, mode: 'demo', api_base: '', site_id: 's1', database: 'sqlite', created_at: '',
  docs_url: '', customization: { home: { blocks: [] } } }`), asserts `readCustomization(config).schema_version === 2`,
  then `expect(readCustomization({ customization: once })).toEqual(once)` — idempotence at the entry point.

### E. Verification (run from `apps/web`)

```
> npx vitest run src/lib/migrate.test.ts
 ✓ src/lib/migrate.test.ts (10 tests) 14ms
 Test Files  1 passed (1)
      Tests  10 passed (10)

> npx vitest run
 Test Files  48 passed (48)
      Tests  541 passed (541)
   Duration  46.34s

> npm run typecheck   # tsc --noEmit
(no output, exit 0)
```

541 = 539 + 2 new tests; 48 files unchanged. (The only intermediate red was the stamp test's `toEqual` diffing
`"description": ""` on five taxonomy tags, which is what drove §C.)
