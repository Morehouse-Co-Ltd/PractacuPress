# P1 Task 2 Report — 内置条件显示（`visible`）

**Status:** DONE
**Commit:** `5cdffa2` on `feat/page-builder-v2-p0`
**Tests:** 55 files / 592 tests green (baseline was 53 / 582; +2 files, +10 tests). `npm run typecheck` clean.

---

## What landed

1. **`apps/web/src/lib/visibility.ts`** (new) — written verbatim from the brief:
   `ViewerRole`, `VisibilityContext`, `roleFromSession(me)`, `isVisibleAt(block, ctx)`.
   Three groups (devices / roles / time window) are AND-ed; a missing group is unconstrained;
   an unparseable date is treated as "no such limit" instead of throwing; `to` is inclusive
   of that whole day (`to + 86_399_999`).
2. **`apps/web/src/lib/visibility.test.ts`** (new) — the brief's six tests, verbatim.
3. **`apps/web/src/components/blocks/index.tsx`** — `ScreenRenderer` now appends the
   visibility filter to the Task 1 chain:

   ```tsx
   const { me } = useAuth();
   const role = roleFromSession(me);
   const now = useMemo(() => new Date(), []);
   const visibility = useMemo<VisibilityContext>(() => ({ device, role, now }), [device, role, now]);
   const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device)
     .filter((block) => !block.hidden)
     .filter((block) => isVisibleAt(block, visibility));
   ```

   `BlockView` filters children by the same rule:
   `.filter((child) => !child.hidden && (!visibility || isVisibleAt(child, visibility)))`.
4. **`apps/web/src/components/blocks/visibilityFilter.test.ts`** (new, **beyond the brief**) — 4 render-level
   tests over the real `ScreenRenderer`. Rationale in "Files beyond the brief" below.

## TDD evidence

| Step | Command | Result |
|---|---|---|
| Red | `npx vitest run src/lib/visibility.test.ts` | `1 failed`, `no tests` — `Failed to resolve import "./visibility"` |
| Green | same | `6 passed (6)` |
| Full | `npx vitest run` | `55 passed (55)` / `592 passed (592)` |
| Types | `npm run typecheck` | clean, no output |

Baseline before touching anything: `53 passed (53)` / `582 passed (582)` — reproduced first, so the
delta is exactly +2 files / +10 tests and nothing regressed.

## Decisions

### Children: React context, not props (brief asked for the reason)

`BlockView` is recursive and its children reach the DOM through three different paths — `columns`
(via `ColumnsBlock`'s `renderChild` closure), `container` (`ContainerBlock`), and the generic
`pp-nested-layer` — plus `renderBlocks` re-groups root blocks into lead/main/side/tail before they
become `BlockView`s. Threading `{device, role, now}` as props would mean changing `flat()`,
`renderBlocks()`, every `<BlockView>` call site (5 of them) and `ColumnsBlock`'s `renderChild`
signature. A context lets each `BlockView` read it and keeps the diff inside one file; the same
directory already solves "descendant needs render-time context" this way (`ScreenScope.tsx`,
`FeedContext.tsx`, `ArticleContext.tsx`), so this is the local idiom rather than a new pattern.

The context is defined in `blocks/index.tsx` (not a new file) so the touched-file set stays as the
brief lists it. Its default is `null`, and `null` means **"no visibility filtering"** — a
`BlockView` rendered outside `ScreenRenderer` (editor previews, future one-block tests) keeps
showing everything, which is what an editing surface should do. Only `ScreenRenderer` supplies
the real context, so the public site path is always filtered.

### Role mapping

`useAuth()` does expose `me` (`AuthValue extends SessionState`, which carries `me: Me | null`), so
the brief's snippet works as written. `roleFromSession` maps `me.role` directly:
`null → guest`, `platform_admin`/`site_admin` → `admin`, everything else logged-in → `member`.

I read `lib/permissions.ts` as instructed and deliberately did **not** route through
`groupIdForRole`. That function is a *permission-group* mapping (`editor → moderator`) and would
collapse `editor` into the admin-ish side, while `BlockVisibility.roles` in `types.ts` is a
three-value audience (`guest | member | admin`). Mixing the two axes would silently change which
audience an `editor` is part of; the brief's direct mapping is the correct one here.

### `now` is sampled once per mount

`const now = useMemo(() => new Date(), [])` (brief verbatim). No timer re-evaluates the time window
mid-session; a block whose window opens at midnight appears on the next load. That is the plan's
intent ("改天换内容靠下一次加载生效") and it keeps the render path free of an interval that would
re-render the whole screen tree. Called out in a code comment so it reads as a choice, not an
oversight.

### Layout tool, not access control

No server assumption added. `lib/visibility.ts` carries the warning in its doc comment: the design
document is the same public JSON for every visitor, so `visible` hides content, it does not protect
it. Nothing in this task touches `apps/api`.

## Files beyond the brief

**`apps/web/src/components/blocks/visibilityFilter.test.ts`** — added on purpose. `visibility.test.ts`
proves the pure function, but the actual risk in this task is the *wiring*: a root filter that is
never applied, children that skip the rule, or a role that never reaches the chain would all leave
the unit tests green. Four tests render the real `ScreenRenderer` (mocking only `lib/session`'s
`useAuth`) and assert on `[data-pp-block]` ids:

1. role mismatch hides a root block;
2. a logged-in `member` sees a `roles: ['member']` block;
3. a child inside a `container` obeys the same rule (desktop viewport, `devices: ['mobile']` child hidden);
4. a screen whose only block is filtered out renders nothing at all (no empty shell).

**Mutation-checked** (so they are not vacuous): forcing the root filter to `|| true` fails tests 1 and 4;
forcing the child predicate to `|| true` fails test 3. Both mutations reverted before commit.

No other files were touched, and `git add` used the four exact paths (no `-A`, no `stash`, no
`checkout --`). The shared working tree's unrelated modifications are untouched.

## Observations for whoever picks up Task 3+

- **Editor preview as an admin.** The builder preview iframe runs with the real session, so it
  evaluates as `role: 'admin'`. A block restricted to `roles: ['guest']` or `['member']` will be
  invisible in that preview. That follows the plan (no preview bypass was specified) but it will
  read as a bug the first time a designer sets "members only" and sees the block vanish from the
  preview while `hidden` behaves differently. A `preview` flag on `VisibilityContext` would be the
  natural fix if the plan wants one.
- `BlockInspector` has no `visible` editing UI yet — this task only makes the field *mean* something
  at render time. The field also survives normalization already (`BlockInstance.visible` in `types.ts`).
- Nothing writes `visible` today, so behavior on existing sites is unchanged by construction.
