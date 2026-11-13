# P1 hand-off #1 — grid span tiers move from container queries to viewport media queries

**Status:** DONE (committed, suite/typecheck/build green)
**Branch:** `feat/page-builder-v2-p0`
**Commit:** `9990ca2` — `fix(web): decide grid span tiers by viewport, matching the override layer`
**Files staged in that commit:** `apps/web/src/styles.css`, `apps/web/src/lib/blocks.ts`, `apps/web/src/lib/gridBlock.test.ts`, `apps/web/src/components/blocks/LayoutBlocks.tsx` (82 insertions, 42 deletions; 4 files)

---

## 1. The bug, restated in one paragraph

The 12-column `grid` block chose its span tier with CSS **container queries**
(`.pp-grid { container-type: inline-size }` + three `@container pp-grid` tiers keyed off the
grid's own inline size), while the per-device override layer
(`applyDisplayOverrides` → `builderDeviceForWidth`) chose the device by **viewport width**.
A grid inside a narrow `section`, a half-width `columns` column, or the bento main column could
be 640 px wide on a 1440 px desktop: the grid laid out with the *mobile* tier while the override
layer believed it was *desktop*. One render, two notions of "which device am I".

## 2. The decision (implemented, not re-litigated)

**One definition of device: the viewport.** Grid tiers now use `@media` at the project's single
breakpoint table (`BREAKPOINT_MD = 768`, `BREAKPOINT_LG = 1024` in `apps/web/src/lib/layout.ts`).
The rationale is preserved in the Chinese comment above `.pp-grid`: the builder preview is a real
iframe whose width *is* its viewport, so media queries re-layout correctly when the author switches
device; container queries bought nothing there but introduced a second, conflicting notion of device.

---

## 3. Task-by-task

### Task 1 — `styles.css`: `@container` tiers → `@media` tiers

Removed:

- `@container pp-grid (max-width: 1023px) { .pp-grid-cell { … --pp-span-md … } }`
- `@container pp-grid (max-width: 767px)  { .pp-grid-cell { … --pp-span-sm … } }`
- `container-type: inline-size;` and `container-name: pp-grid;` from `.pp-grid`
  (grep confirms no `cq*` unit or `container()` value anywhere in `apps/web/src`, so nothing
  was relying on `.pp-grid` being a query container).

Added:

```css
.pp-grid-cell {                     /* 基准 = 手机档 */
  --pp-col-start: calc(var(--pp-offset-sm) + 1);
  --pp-col-span: var(--pp-span-sm);
  …
}
@media (min-width: 768px)  { .pp-grid-cell { … var(--pp-span-md)   … } }
@media (min-width: 1024px) { .pp-grid-cell { … var(--pp-span-base) … } }
```

The renderer's custom properties are unchanged (`--pp-span-base|md|sm`, `--pp-offset-base|md|sm`);
only the switcher changed, plus `--pp-col-start` / `--pp-col-span` still resolve from them, so
`grid-column-start` / `grid-column-end: span var(--pp-col-span)` keep working as before.

### Task 2 — mobile-first ordering, behaviour preserved

The old CSS was **desktop-first with max-width container tiers**: base rule = `base` (desktop)
values, `max-width: 1023px` → `md`, `max-width: 767px` → `sm`. The new CSS is **mobile-first with
min-width media tiers**: base rule = `sm`, `min-width: 768px` → `md`, `min-width: 1024px` → `base`.

Observable behaviour across widths is identical to the old mapping, just re-keyed from container
width to viewport width:

| viewport width | tier | old container rule that produced the same tier (when container ≈ viewport) |
|---|---|---|
| < 768 px | `sm` | `@container (max-width: 767px)` |
| 768–1023 px | `md` | `@container (max-width: 1023px)` |
| ≥ 1024 px | `base` (desktop) | base rule |

The only intended behaviour change is the one the item asks for: **a grid whose container is
narrower than the viewport no longer drops to a lower tier** — it keeps the viewport's tier, the
same judgement `builderDeviceForWidth` and the `at` override layer make. Narrower typography inside
a narrow grid is now an authoring decision (`at` override), not an implicit one.

### Task 3 — `blocks.ts`: exactly one source for "which tier wins"

**What I removed:** nothing in JS needed deleting — there was **no JS ternary duplicating the tier
decision**. `gridPlacements` calls `spanFor` once per tier and returns all three;
`gridCellVars` writes all six variables; `GridBlock` never receives `device`. The duplicated
"which tier wins" logic lived entirely in CSS (the `@container` tiers), and that is what was
removed. The only remaining JS threshold decision is `builderDeviceForWidth` (the override layer),
which now agrees with the CSS by construction — both sides read the same `BREAKPOINT_MD` /
`BREAKPOINT_LG` table.

What I did change in `blocks.ts` is the **stale prose** that still claimed the CSS used container
queries (a comment that contradicts the code is how the next session re-introduces the bug):

- `spanFor` docblock: now states it is a pure per-tier **value** lookup (what the author wrote for
  that tier, falling back to `base` when a tier is unset) and explicitly **does not** decide which
  tier is active — that lives in the media query, keyed off the same viewport width as `at`; all
  three tiers are computed, the browser picks.
- `gridPlacements` docblock: "由 `styles.css` 的容器查询决定谁生效" → "由 `styles.css` 的媒体查询
  决定谁生效（阈值 768 / 1024，与 `builderDeviceForWidth` 同一张断点表）", with the failure mode
  named.
- `gridCellVars` docblock: same correction; notes that the preview iframe's width *is* its viewport,
  so the media query follows the device switch, and that "which tier wins" has a single source (CSS).

`LayoutBlocks.tsx` (`GridBlock` docblock) got the same correction: it used to say the tier comes
from `styles.css`'s `@container` rules and that media queries would never fire inside the iframe.
It now says the tier comes from the media queries at 768 / 1024, the iframe width is its own
viewport, and grid tiers and the `at` override layer agree on "which device am I". No JSX changed.

### Task 4 — `gridBlock.test.ts`: assert the CSS wiring matches the breakpoints

Same approach as `sectionBlock.test.ts`: `import gridCss from '../styles.css?raw'` and assert on
the raw text with `toMatch` / `toContain`. The old describe `栅格断点用容器查询实现` was replaced by
`栅格断点用媒体查询实现（设备只由视口定义）`, which now asserts:

1. `.pp-grid` has **no** `container-type` / `container-name` (and no `container-name: pp-grid`).
2. **No `@container` tier remains attached to `.pp-grid`**: `expect(gridCss).not.toMatch(/@container[^{]*\{[^}]*\.pp-grid/)`.
3. `grid-column-start: var(--pp-col-start)` / `grid-column-end: span var(--pp-col-span)` and the
   base-variable sources (`--pp-col-start: calc(var(--pp-offset-base) + 1)`,
   `--pp-col-span: var(--pp-span-base)`) still exist (kept from the old test).
4. **Mobile-first ordering**: the base `.pp-grid-cell` rule carries `--pp-span-sm` /
   `calc(var(--pp-offset-sm) + 1)`; a `@media (min-width: 768px)` block whose `.pp-grid-cell` rule
   carries `--pp-span-md` / `calc(var(--pp-offset-md) + 1)`; a `@media (min-width: 1024px)` block
   carrying `--pp-span-base` / `calc(var(--pp-offset-base) + 1)`. Offset and span are asserted in
   the *same* block, so a half-md/half-base edit fails.
5. **Threshold literals equal the breakpoint table**: `@media (min-width: 768px)` and
   `@media (min-width: 1024px)` are present literally, and `BREAKPOINT_MD === 768`,
   `BREAKPOINT_LG === 1024`.

The pre-existing test "渲染器写的每个变量名，样式表都读过（改一边就会断）" still welds
`gridCellVars`' keys to `var(--pp-…)` occurrences in the stylesheet, so renderer/CSS drift on the
variable names still breaks the build.

Deliberately **not** asserted: "@container appears nowhere in styles.css". Scoping the assertion to
`.pp-grid` keeps a future, unrelated component free to use container queries without touching this
test.

### Task 5 — the required Chinese comment

Placed as a one-line Chinese comment **immediately above the `.pp-grid` rule**, i.e. between the
big rationale block and the rule itself:

```css
/*
 * 12 栏栅格。
 * …iframe/viewport rationale…
 */
/* 档位只由视口宽决定，与 `at` 覆盖取同一判据；容器再窄也不改档，作者要更窄的排版请用 `at` 覆盖。 */
.pp-grid {
  display: grid;
  align-items: start;
}
```

The larger Chinese block comment above it carries the iframe/viewport rationale the item asked to
preserve.

---

## 4. Verification

All commands run from `apps/web`.

| command | result |
|---|---|
| `npx vitest run src/lib/gridBlock.test.ts src/lib/sectionBlock.test.ts` | 2 files / 24 tests passed |
| `npx vitest run` | **59 files / 672 tests passed** (baseline 59 / 671 — +1 from the new test in this change); re-run green after the final amend |
| `npm run typecheck` (`tsc --noEmit`) | clean, no output (re-run after the final amend) |
| `npm run build` | `✓ 329 modules transformed`, `✓ built in 4.52s`, exit 0; only the pre-existing "chunks larger than 500 kB" warning |

Post-build sanity check of the emitted CSS (`dist/assets/index-DnFDfD76.css`):

```
.pp-grid{display:grid;align-items:start}.pp-grid-cell{--pp-col-start: calc(var(--pp-offset-sm) + 1);--pp-col-span: var(--pp-span-sm);…}
@media(min-width:768px){.pp-grid-cell{--pp-col-start: calc(var(--pp-offset-md) + 1);--pp-col-span: var(--pp-span-md)}}
@media(min-width:1024px){.pp-grid-cell{--pp-col-start: calc(var(--pp-offset-base) + 1);--pp-col-span: var(--pp-span-base)}}
```

No `container-type` survives anywhere in the bundle.

---

## 5. Staging discipline (important for the next session)

`apps/web/src/styles.css` carries ~400 lines of another session's uncommitted work (CSS imports
for `storage.css` / `articleContent.css`, the `.stat-grid` rework, the builder-fullscreen
"no gutter" refactor, plus a large appended block). None of it was touched, staged, stashed or
reverted.

Method used: `git diff -- apps/web/src/styles.css` → extracted **only** the grid hunks for my change
(`@@ -6053,23 +6054,27 @@`, `@@ -6081,16 +6086,16 @@`; later, after moving the required Chinese
comment from above `.pp-grid-cell` to above `.pp-grid`, the single delta hunk `@@ -6064,13 +6065,11 @@`)
→ `git apply --cached --check` → `git apply --cached` → `git commit --amend --no-edit`.
The other three files were entirely mine, so they were staged by explicit path
(`git add -- apps/web/src/lib/blocks.ts apps/web/src/lib/gridBlock.test.ts apps/web/src/components/blocks/LayoutBlocks.tsx`).
`git add -A`, `git stash`, `git checkout -- .` were never used.

After the commit, `git status --short -- apps/web/src/styles.css` is still ` M`: the other
session's **8 hunks remain unstaged and intact in the working tree**
(`@@ -10,6`, `@@ -2387,17`, `@@ -6528,31`, `@@ -6743,11`, `@@ -6827,7`, `@@ -6859,10`,
`@@ -6875,7`, `@@ -7955,3`). The committed blob differs from `HEAD~1` only in the grid region
(verified with `git show HEAD:apps/web/src/styles.css`).

---

## 6. Notes / residual risk

- **Intentional behaviour change**: a grid in a narrow container no longer shrinks its tier. This is
  the point of the item, but it means existing content authored against the old container-driven
  behaviour (a grid inside a half-width column that *looked* fine on desktop because it silently
  went `sm`) will now render at the desktop tier. Authors who want the narrow layout must set it
  through `at` (mobile/tablet overrides), which is now the only way to get a different tier at a
  narrower width. Nothing in seed/demo content was changed by this item.
- `BlockInspector.tsx` still reads `gridPlacements(...).base` for the desktop editing UI. That is
  correct under the new rule (desktop tier == base tier == what CSS applies at ≥ 1024 px) and the
  file was not in scope, so it was left untouched.
- The builder's per-device preview and the site front-end both rely on the iframe/Viewport width
  being the real viewport; the other session's `.builder-fullscreen` refactor (preview = full-width
  iframe, floating panels) is what makes that true, and it is exactly what this change assumes.
- Test count moved 671 → 672 because one new `it(...)` was added to `gridBlock.test.ts`
  (the old describe had 4 cases, the new one has 5).
