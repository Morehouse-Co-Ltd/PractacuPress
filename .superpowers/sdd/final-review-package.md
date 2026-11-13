# P0 whole-branch review package

Branch: feat/page-builder-v2-p0 (HEAD 2edee60)
Merge base: e8e138c (docs: plan the page builder v2 P0 foundation)

## Commits on the branch

2edee60 perf(api): gzip JSON responses and cache public media at the edge
b8a3a4f feat(web): enforce design volume budgets and guard saves at the block limit
cc0409a perf(api): serve the site design document with an ETag and answer 304
6ae02d2 fix(web): tighten the media url whitelist and let demo inline images through
b415c09 fix(api): let an anonymous reader fetch an image referenced by the site design
93311f1 feat(web): add the media property type and a media library picker
2518693 test(web): guard that every block's defaults survive the props whitelist
ff5fa50 feat(web): add repeater property schema and migrate the button block to it
07f9b40 fix(web): persist the schema stamp and bound the migrator's recursion
3ec5f8a feat(web): add schema v2 block fields, version stamp and the v1 to v2 migrator
d614e23 feat(web): paint the caret line's markdown marker and portal the editor overlays
e032b4a fix(web): harden the unknown-block path and widen the budget tests
e1fe2a1 feat(web): markdown line markers, anchored slash menu, soft paragraph breaks
2775d8f fix(web): paint nothing for blocks from a newer schema
f8515d3 fix(web): keep unknown block types and drop the silent root-level cap
6c08616 test(web): pin cross-parent moves and the findBlock/stepTarget seam
3c6a6b3 fix(web): make the tree panel move-down button use the corrected drop index
8614641 fix(web): compensate the drop index when a block moves down inside one parent
4e3906b docs: spec and plan for the editor markdown affordances

## Diffstat (contains other sessions' WIP - see scope note)

 apps/api/cmd/server/main.go                        |   81 +-
 .../infrastructure/sitestore/design_reference.go   |  110 ++
 .../sitestore/design_reference_test.go             |   20 +
 apps/api/internal/media/cache_control_test.go      |   70 ++
 apps/api/internal/media/handler.go                 |   14 +-
 apps/api/internal/media/service.go                 |  124 ++-
 apps/api/internal/site/customization_etag_test.go  |   37 +
 apps/api/internal/site/handler.go                  |   42 +
 .../transport/http/gin/gzip_router_test.go         |   57 +
 .../internal/transport/http/gin/middleware/gzip.go |  167 +++
 .../transport/http/gin/middleware/gzip_test.go     |  222 ++++
 apps/api/internal/transport/http/gin/router.go     |    5 +
 apps/web/scripts/e2e-builder-blocks.mjs            | 1151 ++++++++++++++++++++
 apps/web/src/components/RichTextEditor.tsx         |  388 ++++++-
 apps/web/src/components/SlashMenu.tsx              |   91 +-
 apps/web/src/components/blocks/ActionBlocks.tsx    |   81 ++
 apps/web/src/components/blocks/index.tsx           |   69 +-
 apps/web/src/components/builder/BlockProps.tsx     |  235 +++-
 .../components/builder/BlockPropsRepeater.test.ts  |  102 ++
 .../web/src/components/builder/BlockTreeEditor.tsx |   19 +-
 apps/web/src/components/builder/MediaPicker.tsx    |   78 ++
 apps/web/src/lib/blockTree.test.ts                 |    3 +-
 apps/web/src/lib/blockTree.ts                      |   30 +-
 apps/web/src/lib/blockTreeMove.test.ts             |   79 ++
 apps/web/src/lib/blocks.ts                         |  150 ++-
 apps/web/src/lib/blocksData.ts                     |  183 ++++
 apps/web/src/lib/caretRect.test.ts                 |   90 ++
 apps/web/src/lib/caretRect.ts                      |   84 ++
 apps/web/src/lib/covers.test.ts                    |   12 +-
 apps/web/src/lib/customize.ts                      |  594 +++++++++-
 apps/web/src/lib/customizeBlocks.test.ts           |   70 ++
 apps/web/src/lib/editorBlockMarker.test.ts         |   57 +
 apps/web/src/lib/editorBlockMarker.ts              |   56 +
 apps/web/src/lib/htmlToMarkdown.test.ts            |   13 +
 apps/web/src/lib/htmlToMarkdown.ts                 |   24 +-
 .../fragments/components_builder_MediaPicker.ts    |   13 +
 apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts |    2 +
 .../src/lib/i18n/dict/fragments/lib_customize.ts   |    4 +-
 .../dict/fragments/pages_admin_ThemeBuilder.ts     |    3 +
 apps/web/src/lib/markdownExport.test.ts            |   31 +
 apps/web/src/lib/markdownExport.ts                 |   79 ++
 apps/web/src/lib/mediaProps.test.ts                |   50 +
 apps/web/src/lib/migrate.test.ts                   |  151 +++
 apps/web/src/lib/migrate.ts                        |  152 +++
 apps/web/src/lib/repeaterProps.test.ts             |   81 ++
 apps/web/src/lib/screenLayout.test.ts              |   23 +-
 apps/web/src/lib/volumeBudget.test.ts              |   43 +
 apps/web/src/pages/admin/Editor.tsx                |    6 +-
 apps/web/src/pages/admin/ThemeBuilder.tsx          |   31 +-
 apps/web/src/styles.css                            |   31 +
 apps/web/src/styles/editorMarkdown.css             |   39 +-
 apps/web/src/types.ts                              |  210 +++-
 .../2026-11-02-editor-markdown-affordances-plan.md |  633 +++++++++++
 ...026-11-02-editor-markdown-affordances-design.md |  202 ++++
 54 files changed, 6137 insertions(+), 255 deletions(-)

## Per-task detail

- .superpowers/sdd/progress.md (ledger)
- .superpowers/sdd/task-1-report.md, web-task-2-report.md ... web-task-6-report.md, api-task-1-report.md ... api-task-3-report.md
