# P1 phase review package

## Commits (P1)

3d96cf1 feat(web): edit per-device overrides in the inspector
91f5a60 fix(web): never drop a device tree whose content differs from the base
7ae7d2d feat(web): fold legacy split-device layouts now that at is rendered
c199534 feat(web): fold pixel widths into grid spans once
6a87844 feat(web): add the section block
349c9c7 feat(web): add the 12-column grid block
8e3d2f3 fix(web): keep role-restricted blocks visible in the builder preview
3af5988 test(web): guard the override merge rules and restore literal i18n keys
5cdffa2 feat(web): evaluate per-block visibility at render time
d48ff02 feat(web): evaluate per-device overrides and unify the breakpoint table

## Diffstat
 apps/web/src/components/LogicRuntime.tsx           |   5 +-
 apps/web/src/components/blocks/LayoutBlocks.tsx    |  75 +++++-
 apps/web/src/components/blocks/index.tsx           |  92 ++++++-
 .../src/components/blocks/visibilityFilter.test.ts | 108 ++++++++
 apps/web/src/components/builder/BlockInspector.tsx | 296 +++++++++++++++++++--
 .../web/src/components/builder/BlockTreeEditor.tsx |  26 +-
 apps/web/src/lib/blockAppearance.ts                | 186 +++++++++++++
 apps/web/src/lib/blocks.ts                         | 250 ++++++++++++++++-
 apps/web/src/lib/customize.ts                      |  32 ++-
 apps/web/src/lib/gridBlock.test.ts                 | 130 +++++++++
 .../fragments/components_builder_BlockInspector.ts |  28 ++
 apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts |  41 +++
 apps/web/src/lib/layout.test.ts                    | 162 +++++++++++
 apps/web/src/lib/layout.ts                         | 123 +++++++++
 apps/web/src/lib/logic.ts                          |   9 +
 apps/web/src/lib/migrate.test.ts                   | 181 +++++++++++++
 apps/web/src/lib/migrate.ts                        | 113 +++++++-
 apps/web/src/lib/screenLayout.test.ts              |  39 ++-
 apps/web/src/lib/sectionBlock.test.ts              | 128 +++++++++
 apps/web/src/lib/visibility.test.ts                |  63 +++++
 apps/web/src/lib/visibility.ts                     |  62 +++++
 apps/web/src/lib/widthToSpan.test.ts               |  84 ++++++
 apps/web/src/pages/admin/ThemeBuilder.tsx          |  41 ++-
 apps/web/src/styles.css                            |  54 ++++
 apps/web/src/types.ts                              |   8 +
 apps/web/vitest.config.ts                          |   3 +
 26 files changed, 2281 insertions(+), 58 deletions(-)
