# P3 · Task 2 — `content-query` 查询块 · Report

**Status:** DONE
**Commit:** `5ec5318` — `feat(web): add the content query block`
**Branch:** `feat/page-builder-v2-p0`
**Scope:** new page-builder block that reads live content through P3 Task 1's four list filters
(`category_id` / `tag` / `since` / `sort`), with a demo-mode path that does **not** fake server filtering.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/lib/blocks.ts` | `content-query` registry entry + `queryRequest()` / `sinceFromWindow()` / `ContentQueryRequest` |
| `apps/web/src/components/blocks/QueryBlocks.tsx` | **new** — `QUERY_RENDERERS` (one renderer) |
| `apps/web/src/components/blocks/index.tsx` | spread `QUERY_RENDERERS` into `RENDERERS` |
| `apps/web/src/lib/api.ts` | `ContentListOptions` + `listContent` passes the four new params (same request path, no second one) |
| `apps/web/src/lib/backend.tsx` | `Backend.listContent` options type → `ContentListOptions` |
| `apps/web/src/lib/loading.ts` | `BLOCK_SKELETON_SHAPES['content-query'] = 'grid'` |
| `apps/web/src/styles.css` | appended `P3 · 内容查询区块` section |
| `apps/web/src/lib/i18n/dict/fragments/components_blocks_QueryBlocks.ts` | **new** — English entries |
| `apps/web/src/lib/queryBlock.test.ts` | **new** — 24 tests |
| `apps/web/src/components/blocks/DataBlocks.tsx` | `ArticleCard` exported for reuse (see below) |

## What was built

### Registry (`lib/blocks.ts`)

`content-query`, `group: 'content'`, `variants: ['classic', 'bento']`, defaults
`{ source: 'latest', term_id: '', window: 'all', sort: 'newest', layout: 'grid', limit: 6,
show_excerpt: true, show_meta: true }`, schema exactly the brief's table (`source` four options,
`term_id` text, `window` all/7d/30d, `sort` newest/oldest, `layout` list/grid, `limit` 1–24 number,
two toggles). Defaults survive `normalizeBlockProps` unchanged (the global "read → write is
idempotent" test in `repeaterProps.test.ts` covers every block, so this was not optional).

Two pure functions live next to the file's other pure block helpers (`gridTemplate`,
`sectionLayout`), because the brief's test imports them from `./blocks`:

```ts
sinceFromWindow('all' | '7d' | '30d' | <garbage>, now: Date): string | undefined
queryRequest(props: BlockProps, now?: Date): ContentQueryRequest
```

- `sinceFromWindow` is millisecond arithmetic (`now - days * 86_400_000`), then `toISOString()` —
  no local-time conversion, so DST cannot eat an hour; `all` and any unrecognised value return
  `undefined` ("no time condition") instead of guessing a window.
- `queryRequest` trims `term_id`, clamps `limit` to 1–24 (default 6), normalises `sort`/`layout`,
  and **only then** attaches one filter for the selected source. Empty values never become `''`
  params: `category_id=` is "filter by an empty category" on the server, i.e. always empty.
- `author` maps to `authorId` (`author_id`), a filter the row already supports and `Profile.tsx`
  already uses — the brief's `source: author` option would otherwise do nothing. The plan's
  "Produces" line lists `categoryId`/`tag`/`since`/`sort`/`limit`/`layout`; `authorId` is the one
  addition, and it is the same existing parameter, not a new request path.

### Renderer (`components/blocks/QueryBlocks.tsx`)

Two existing data paths, chosen at runtime via `isDemo(useBackend())`:

- **live** — `backend.listContent('article' | 'post', …)` in parallel, each carrying
  `limit / categoryId / tag / authorId / since / sort`. The two endpoints are each sorted
  server-side; the merged list is re-sorted once with `published_at ?? created_at` so the merged
  page honours `sort`, then sliced to `limit`.
- **demo** — no request at all: the block renders `useFeed().all` (the existing demo data path)
  sliced to `limit`. Nothing is filtered or re-sorted locally, and the demo backend is never asked
  to pretend it can filter. `feed.loading` drives the loading line; a page-level skeleton can cover
  it first (see skeleton registration).

Loading shows one line (`正在读取内容…`), the empty result renders exactly one sentence
(`这里还没有内容。`) as a `<p class="pp-query-empty">` — no empty container, per the brief.

Cards reuse `ArticleCard` from `DataBlocks.tsx` (now exported) and the existing
`.pp-article-grid.is-list|is-grid` / `.pp-article-card` styles, so the block looks identical to the
「文章组件」 block and no card CSS is duplicated. The new CSS section only adds the container rhythm
(`.pp-query-block`) and the muted empty line (`.pp-query-empty`), plus point-free comments.

`useMemo(() => new Date(), [])` pins "now": `since` is derived from it, so recomputing it per render
would make `useAsync`'s dependency list change forever and refetch in a loop.

### Demo-mode hints (editor side)

`schema.hint` on the three filter conditions says it plainly:

- `term_id`: 「填 id 或名称，留空就是不筛选。演示模式不按它筛选。」
- `window`: 「按发布时间筛选。演示模式不按时间筛选。」
- `sort`: 「演示模式不按它排序。」

So the editor tells the author that these conditions do not apply in demo mode, while hidden behind
them the renderer really does not apply them.

### Skeleton

`BLOCK_SKELETON_SHAPES['content-query'] = 'grid'` — the closest existing shape, the same one
`articles` uses (the block can render as list or grid, but both are the same card family). Its
comment records that the block reads feed data in demo mode and its own data live, so it can be
waiting either way.

### i18n

21 new keys, all `t()`-wrapped in source. They live in a **new** fragment
(`components_blocks_QueryBlocks.ts`) instead of `lib_blocks.ts` because that file carries other
sessions' unstaged hunks in this shared tree; the dictionary is a glob merge, so a new fragment is
conflict-free and equivalent. Existing shared keys (`分类`, `标签`, `全部`, `显示摘要`, `显示日期`) are
reused, not redefined. `source: author` uses `按作者` rather than `作者`, because `lib_blocks.ts`
already maps `作者` → "Artist" for the audio block.

## Tests (TDD, red → green)

Red first: `npx vitest run src/lib/queryBlock.test.ts` failed with
`Failed to resolve import "../components/blocks/QueryBlocks"` (the module the block needs did not
exist yet) — i.e. the test was written and run before any implementation.

`apps/web/src/lib/queryBlock.test.ts` — 24 tests in five groups:

1. `sinceFromWindow` — the brief's three cases verbatim (`all`, `7d`/`30d` → RFC3339, garbage).
2. `queryRequest` — the brief's three cases verbatim, plus tag/author trimming and mutual exclusion,
   sort fallback, limit clamping (1/24/6) and layout fallback, `window → since`.
3. registry — group/variants, defaults shape, defaults ⊂ schema, normalisation idempotence, option
   values for `source`/`window`/`sort`/`layout`, `limit` bounds + toggles, and that the three demo
   hints mention 演示模式.
4. renderers/skeleton — `BLOCK_RENDERERS['content-query']` exists, `QUERY_RENDERERS` has only that
   key, skeleton shape registered.
5. rendering — demo mode makes **zero** `listContent` calls and shows the one-sentence empty state;
   live mode calls both kinds with `categoryId`/`sort`/`limit` (and no `since` for `all`), renders
   cards, re-sorts the merged list by `sort`, truncates at `limit`, and uses the shared
   `.pp-article-grid.is-list` / `.pp-article-card.is-list` classes. CSS section assertions for
   `.pp-query-empty` and `.pp-query-block`.

## Verification

| Command (from `apps/web`) | Result |
| --- | --- |
| `npx vitest run` | **68 files / 857 tests passed** (baseline 67 / 833, +1 file / +24 tests) |
| `npm run typecheck` | clean |
| `npm run build` | clean (vite build, only the pre-existing >500 kB chunk warning) |
| `npm run i18n:audit` | 96.3% covered, 193 pending — unchanged by this task; `QueryBlocks.tsx` has 0 pending, and no added line in `blocks.ts` is an unwrapped Chinese literal (verified against the diff) |

## Shared working tree — how this commit stays scoped

The tree carries other sessions' uncommitted work (≈124 modified + many untracked files, including
the whole skeleton-loading and site-domain features). Nothing was swept in:

- `blocks.ts`, `index.tsx`, `DataBlocks.tsx`, plus the three new files: staged whole (their diffs are
  100 % mine).
- `api.ts`, `backend.tsx`, `styles.css`: **hunk-level** staging — a filtered patch (only my hunks) was
  applied with `git apply --cached --recount`, so the index holds HEAD + my changes while the working
  tree keeps everyone's. Their other hunks remain unstaged (` M` after the commit), as intended.
- `loading.ts`: my one-line registration cannot exist without the `SkeletonShape` type and the
  `BLOCK_SKELETON_SHAPES` map, which are a concurrent session's **uncommitted** addition. The staged
  file is therefore `HEAD + that registry declaration + my entry` (32 lines); the sibling's presets /
  `SkeletonMode` helpers in the same file were **not** staged. Their working-tree version is
  untouched. Note: `HEAD` already imports `BLOCK_SKELETON_SHAPES` and `../SkeletonMode` from committed
  `components/blocks/index.tsx`, and `HEAD`'s `loading.ts` does not export the former and `HEAD` has
  no `SkeletonMode.tsx` — so `HEAD` did not typecheck even before this task. Staging the registry
  makes `loading.ts` consistent with the already-committed import; the rest is theirs to commit.

No `git add -A`, no `git stash`, no `git checkout -- .`.

## Files touched beyond the brief

1. `apps/web/src/components/blocks/DataBlocks.tsx` — `ArticleCard` exported (card markup/style reuse
   instead of a copy).
2. `apps/web/src/lib/backend.tsx` — `listContent`'s options type is part of the `Backend` interface;
   without it the renderer cannot pass the new params (typecheck failure).
3. `apps/web/src/lib/i18n/dict/fragments/components_blocks_QueryBlocks.ts` — new fragment instead of
   adding entries to the contended `lib_blocks.ts`.

## Notes / follow-ups for the parent

- Demo mode intentionally applies **no** filter, including `sort`; the hints say so. If the product
  wants demo mode to filter client-side, that is a separate, honest change (local taxonomy lookup
  instead of a fake server call) and should be decided, not slipped in.
- Live mode has no dedicated error UI: a failed `listContent` falls through to the same one-sentence
  empty state (same as `popular-content` / `recent-content`).
- `author` filtering is implemented via the pre-existing `author_id` param; if the API team adds a
  different author filter later, only `queryRequest` needs to change.
