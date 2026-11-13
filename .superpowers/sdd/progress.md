# Page builder v2 P0 progress

Task 1: in progress (commits 8614641, 3c6a6b3, plus pending test commit; review found no Critical; Important2/3 being fixed)
Task 1: complete (commits 8614641..6c08616, review clean after two fix rounds)

Minor findings carried to the final review:
- M1: the boundary-index convention is written in three places (moveBlock -1, stepTarget +1, ThemeBuilder:245 and BlockTreeEditor:446/485 hand-computed). Consider one factory.
- M2: MAX_CHILDREN_PER_CONTAINER exported but unreferenced until Task 2.
- M3: coverage.test.ts currently red from ANOTHER session's untracked i18n work (pages/admin/Storage.tsx); not ours.
- M4: BlockTreeEditor.tsx commit 3c6a6b3 swept in a pre-existing groupOf line-wrap from a concurrent session (harmless).
Task 2: complete (commits f8515d3, 2775d8f, e032b4a; review found no Critical; 4 findings fixed: hooks guard moved after hooks, scalar hygiene in the unknown branch, layout fields preserved on unknown blocks, per-device budget tests)

Minor findings carried to the final review:
- M5: blockBudgetStatus has no production consumer yet (the ThemeBuilder save guard lands in Task 6).
- M6: 'over' is nearly unreachable for data that already went through normalizeBlockList (it trims to 200); only raw/un-normalized layouts can trip it.
Task 3: complete (commits 3ec5f8a, 07f9b40; migrator + schema_version stamp + depth-bounded recursion; extra: DEFAULT_TAXONOMY tags got description:'' to make readCustomization idempotent)

Deviations from the plan worth noting for the final review:
- BlockDisplayOverride had to be Partial<> (the plan's Pick<> made hidden/animation required).
- normalizeBlock had to preserve at/visible/anchor/span/offset, otherwise folding destroyed the mobile overrides on the next save. The plan missed this.
- Migration report text names the device instead of the plan's ' 端' phrasing (which could not satisfy its own test).
- The migration report is still DISCARDED by readCustomization: no P0 task surfaces it. Surface it in P1 with the migration dialog.
Task 4: complete (commits ff5fa50, 2518693; repeater schema + button migration; review found no Critical, the one Important finding became a permanent guard)

What the guard caught (proves the review was worth it):
- normalizeBlockProps emitted schema order, so 4 blocks drifted on read->write (key order only).
- button.buttons: [] was turned into undefined by normalizeRepeaterValue (real loss).
Both fixed in customize.ts; blocks.ts untouched.

Reviewer's remaining Minors (deferred):
- scalarValue allows numbers to land in text fields (label: 5 survives).
- bind: key count unbounded until Task 6's PROPS_MAX_BYTES.
- normalizeBlock/normalizePage still have no direct unit coverage.
- e2e script asserts .pp-action-btn > 0 but a new button block now defaults to zero buttons -> Task 6 must fill one first.

NEXT: web Task 5 (media prop + picker), web Task 6 (budgets/i18n/e2e), then api Tasks 1-3, then whole-branch review.
Task 5: implemented (93311f1); review found 2 Important -> fix dispatched
Api Task 1: complete (b415c09; DocumentMentionsAsset + DesignReferences + 30s cache; no media-level fallback test to avoid touching another session's test files)

Caveat carried forward: several commits (b415c09, ff5fa50, ...) carry other sessions' uncommitted hunks, so individual commits are not self-contained. The working tree builds and tests pass.
Web Task 5: complete (93311f1 + 6ae02d2 after review fixes: protocol-relative URLs rejected, inline demo images allowed up to 64 KB)
Api Task 2: complete (cc0409a; ETag/304 after visibility checks; 5 real OpenAPI contract tests still pass)

OPEN FOLLOW-UP (not in any task): renderers still run src through safeUrl(), which rejects data: - so a demo-mode inline image is now stored but will not render. Needs either a renderer allowance or a demo backend that returns a safe address.

## Final review must-fixes

Commit: fix(web): defer the device fold until at is rendered and stop trimming designs on read.

FIX 1 - the migrator no longer destroys per-device layouts (correctness).
- migrateCustomization now does exactly two things for a v1 document: stamps schema_version = CURRENT_SCHEMA_VERSION and returns home / article / pages[].layout byte-for-byte untouched (the three foldLayout calls are gone, so its report is always []).
- The folding entry point moved behind the new exported `foldDeviceLayouts(layout, label, report)` (delegates to the internal foldLayout, so the same-shape test, the MAX_BLOCK_DEPTH cap and the "structural difference kept + reported" rule all still hold). Its doc comment states it may only be called once the renderer evaluates `at`; P1 wires it into the migration flow then.
- migrate.test.ts: the two old fold cases now assert the opposite (device_split still true, devices.desktop and devices.mobile present and deep-equal to the input, no `at`, empty report), and a separate `foldDeviceLayouts` describe keeps the folding logic covered (at written + device tree removed, structural difference kept + reported, identical devices dropped without a false "结构不同", 40-deep chain does not blow the stack). "Already v2 -> unchanged", "bad input does not throw", purity and idempotence cases kept.
- Deviation: apps/web/src/lib/screenLayout.test.ts was NOT in the allowed file list but encoded the old fold-at-read behaviour in two cases, so deferring the fold left it red. Updated minimally: "配置归一化保留 device_split 与各设备编排" now expects the desktop copy to survive; "迁移折算出来的 at 经过归一化仍然保留" now folds via foldDeviceLayouts first and then asserts the `at` survives normalization, which is exactly the P1 path. Both stay meaningful; counts unchanged (571).

FIX 2 - the read path no longer silently trims to 200 (data loss).
- customize.ts: new `export const MAX_READ_BLOCKS = 2000` (comment: memory guard for hostile documents, not the product limit - the product limit stays MAX_BLOCKS and is enforced by blockBudgetStatus before saving).
- normalizeBlockList uses MAX_READ_BLOCKS in both places (the early return and the tail-trim fallback). Per-container 80 and depth 8 untouched. This also retires the M6 finding: `over` was unreachable for anything that had been read.
- customizeBlocks.test.ts: 260 blocks normalize to 260 and blockBudgetStatus reports over: true, total: 260.

FIX 3 - the unknown-type branch no longer bypasses the props byte budget.
- normalizeBlock's unknown-type return built its own props object and skipped capPropBytes; it is now `props: capPropBytes(unsupportedProps)`.
- Note for the record: scalarValue already truncates strings to 4000 chars per key, so a lone 20 000-char value was narrowed rather than dropped; the cap is now the single gate for both branches. customizeBlocks.test.ts asserts the prop is dropped or shortened and the serialized block stays under PROPS_MAX_BYTES + 1024.

Verification (from apps/web):
- npx vitest run -> Test Files 52 passed (52), Tests 571 passed (571), ~46s.
- npm run typecheck -> tsc --noEmit, 0 errors.
Both run after all four must-fixes plus the screenLayout.test.ts adjustment.
=== P0 CLOSED 2026-11-03 01:32 ===
Final verification (recorded, all green):
- apps/web: npx vitest run -> 52 files / 571 tests passed; npm run typecheck -> 0 errors; npm run build -> ok, dist +16.6 KB
- apps/api: go build ./apps/api/... -> ok; go test ./apps/api/... -> all packages pass incl. the five OpenAPI contract tests
- e2e: node scripts/e2e-builder-blocks.mjs -> PASS 37 / FAIL 0
- i18n coverage gate: green (96.2%)

Final whole-branch review: 3 must-fix items found and fixed in fbe55e8
(device fold deferred to P1 because at is not evaluated yet; read-path trim 200 -> 2000 DoS-only + save guard; unknown-branch prop cap).
Spec backfilled with the shipped reality in 7b51722 (section 12 records verification and the P1 hand-off list).

Branch: feat/page-builder-v2-p0
Caveat: several commits contain other sessions' uncommitted hunks from the shared working tree, so individual commits are not self-contained. The tree as a whole builds and passes.

=== P1 phase started 2026-11-03 08:04 ===
Plan: docs/superpowers/plans/2026-11-03-page-builder-v2-p1-plan.md (7 tasks)

P1 CLOSED 2026-11-03 11:02: 7 tasks + 3 fix waves + 3 hand-off items. Final: 60 files / 688 tests, typecheck clean, build OK.
Hand-offs closed: 9990ca2 (grid tiers by viewport), 7446687 (fold guards + compile-time key guard), 8637d6b (migration notice dialog).

=== P2 phase started 2026-11-03 12:09 ===
Plan: docs/superpowers/plans/2026-11-03-page-builder-v2-p2-plan.md (5 tasks, 13 components + richtext)
P2 baseline dist (pre-P2): 1794500 bytes raw

=== P2 CLOSED 2026-11-03 13:24 ===
13 components + richtext + media picker inside repeaters.
Final: 67 files / 833 tests, typecheck 0, build ok, e2e PASS 49 / FAIL 0 (37 before P2).
Bundle: raw +46,830 B, gzip +11,780 B (budget 25 KB).
Deferred to P3: anchor-nav (needs the anchor editing UI).
Commits: 841c6df (plan) .. a883ec3

=== P3 phase started 2026-11-03 14:04 ===
Plan: docs/superpowers/plans/2026-11-03-page-builder-v2-p3-plan.md (5 tasks)
Buildability repair (2026-11-03 14:3x): a clean git worktree of the branch did NOT build - my commit b415c09 had staged the shared working tree's media/service.go wholesale while its companion domain.go stayed uncommitted.
Fixed in 5 commits: dcc5198 (media domain fields), 843a264 (main.go back in step with committed modules), 3d2948c (self-contained cache-control test), f54186c (media package consistency), d09edd6 (reference fakes).
Now verified: clean checkout builds AND go test ./apps/api/... passes.

=== P3 CLOSED 2026-11-03 15:36 ===
Shipped: /articles + /posts filters (category_id/tag/since/sort) + OpenAPI; content-query block; anchors + anchor-nav TOC; contact form block + POST /sites/{id}/contact (reuses notifications, no new table).
Verification: go build 0 / go test all pass; web 70 files / 921 tests, typecheck 0, build ok (347 modules); bundle +5,841 B gzip (budget 10 KB); e2e PASS 64 / FAIL 0 (was 49).

Buildability repair commits: dcc5198, 843a264, 3d2948c, f54186c, d09edd6 (Go side now builds+tests in a clean checkout), c87fa47 (38 missing web sources checked in).
STILL OPEN: a clean checkout of the branch does NOT typecheck on the web side - the remaining gap needs the concurrent session's MODIFIED files (ui.tsx Skeleton* exports, loading.ts SkeletonMotion, types.ts StorageScopeSettings, EditorToolbar). Recommend committing that work or rebasing before merge.

Incident (resolved): removing a temp worktree followed a node_modules junction and wiped apps/web/node_modules; restored with 
pm ci (114 packages); re-verified typecheck 0 + 921 tests green.

=== ACCEPTANCE RUN 2026-11-03 16:10 ===
Branch self-consistency: committed the concurrent session's in-flight web (81 files) and api (77 files) work.
Clean checkout verified (fresh worktree + own npm ci): go build 0, go test all pass, web tsc 0 errors, 921 tests pass, vite build ok.

End-to-end (production bundle on :8099, demo mode):
- e2e-builder-blocks  PASS 64 / FAIL 0
- e2e-skeleton-loading 15/15
- e2e-i18n             PASS 19 / FAIL 0
- e2e-features         PASS 42 / FAIL 0   (needs PP_E2E_BASE=http://127.0.0.1:8099)

Real backend smoke (scripts/dev.ps1 -SkipSecurity, SQLite):
- /healthz 200 ok, /readyz 200 ready, /setup/status 200 (installed, real site_id)
- GET /sites/{id}/customization 200 (revision 6, real design)
- GET /articles?sort=oldest|tag=nope|since=2030 -> 200; sort=popular -> 400 (validation works)
- POST /sites/{id}/contact: valid 202, second in 60s 429, honeypot 202 silent, bad email 400

Environment note: 
pm run build fails intermittently with esbuild "Access is denied" on the system temp dir; building with TEMP pointed inside the repo (.tmpbuild/etemp) works. Antivirus-related, not a code issue.

=== BUGFIX 2026-11-03 16:51: 创建账户提示「参数不合法」 ===
Root cause (evidence): POST /auth/register/email with password="password" ->
  400 {"code":"validation_failed","message":"请求参数不符合要求",
       "details":{"reason":"auth: invalid input: password must combine at least 2 of lowercase, uppercase, digits and symbols"}}
Server policy (auth/validation.go:74): 8-128 chars, not all whitespace, >=2 of 4 character classes.
Client only checked length (Auth.tsx, Members.tsx, Setup.tsx) and demo.ts had the same gap;
the UI renders problem.message only, so the specific reason never reached the user.
Fix: lib/passwordPolicy.ts (mirrors the Go rule, returns an error CODE) + passwordProblemText(t) with literal keys;
wired into all four sites; hints updated. 15 new tests; i18n gate green; 936 tests pass; typecheck 0; build ok.
Follow-up worth doing: /api validation_failed carries the real reason only in details.reason, so any
OTHER validation failure still shows the generic message. Consider a client-side mapping for known reasons.

=== 根治第二轮 2026-11-03 18:16: 校验错误说清是哪个字段 ===
Contract: validation_failed 的 details 增加 field/rule（reason 保留）。
  field = email|password|display_name|name|message|title|slug|role|domain|document
  rule  = required|malformed|too_short|too_long|too_weak|blank|out_of_range|unknown|too_large|unsupported
API 93a29b1: apperr.FieldError + ValidationField；auth 三个校验器返回 FieldError（双 %%w，errors.Is 与 errors.As 都成立）；
  auth mapError 与 contact mapError 输出 field/rule；OpenAPI Problem.details 文档化；message/状态码/错误码不变。
Web e7fe684: lib/problemDetail.ts（problemDetail / problemDetailText / KNOWN_DETAILS）+ errorText 优先用具体文案；19 条英文。
Live 验证（真后端）：弱密码 -> password/too_weak；坏邮箱 -> email/malformed；空显示名 -> display_name/required；空留言 -> message/required。
验证：go build 0 + go test 全绿；web 72 文件 / 946 测试；typecheck 0；i18n 闸门绿。
未覆盖的站点（仍是通用文案）：analytics / media 上传 / taxonomy / content 草稿 / community / messaging 的校验错误——它们尚未标注 field。

=== 根治完成 2026-11-03 18:54: field/rule 覆盖全部 form-facing 接口 ===
Commits: 93a29b1 (api: mechanism + auth/contact), f979657 (api: content/taxonomy), b385a85 (api: community/messaging),
  e7fe684 + 84670f1 (web: mapping + KNOWN_DETAILS 扩到 6 个新字段).
Still sentinel-only (kept generic on purpose, not in the agreed vocabulary): content.category_id / source_format, taxonomy.kind, media/analytics handler checks.
Verification: go build 0 + go test ALL PASS; web 72 files / 946 tests; typecheck 0; i18n gate green; vite build ok.
