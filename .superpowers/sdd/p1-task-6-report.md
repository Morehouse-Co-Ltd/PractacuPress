# P1 Task 6 report — 打开 v1 三端布局的自动折算

- **Status:** complete
- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `7ae7d2d` — `feat(web): fold legacy split-device layouts now that at is rendered`
- **Tests:** `apps/web` **58 files / 637 tests green**（基线 58 / 632 + 5 条新用例）；`npm run typecheck`（`tsc --noEmit`）exit 0
- **Brief:** `.superpowers/sdd/p1-task-6-brief.md`（正文中文 mojibake，按代码块 + 计划 `.md` 的 Task 6 原文执行，两者一致）

---

## 1. 交付物

### 1.1 `migrateCustomization` 增加可选的 `foldDevices`（`apps/web/src/lib/migrate.ts`）

```ts
export interface MigrateOptions {
  foldDevices?: boolean;
}

function pageLabel(page: Record<string, unknown>): string {
  const title = typeof page.title === 'string' ? page.title.trim() : '';
  return title ? `页面「${title}」` : '页面';
}

/** 把一份文档里的三端编排折算掉；`doc` 已经是浅拷贝，这里只替换其中的字段。 */
function foldDocument(doc: Record<string, unknown>, report: string[]): void {
  if (doc.home !== undefined) doc.home = foldDeviceLayouts(doc.home, '首页', report);
  if (doc.article !== undefined) doc.article = foldDeviceLayouts(doc.article, '文章页', report);
  if (!Array.isArray(doc.pages)) return;
  doc.pages = doc.pages.map((page) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
    const entry = page as Record<string, unknown>;
    if (entry.layout === undefined) return page;
    return { ...entry, layout: foldDeviceLayouts(entry.layout, pageLabel(entry), report) };
  });
}

export function migrateCustomization(raw: unknown, options: MigrateOptions = {}): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, report: [] };
  const doc: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  if (version >= CURRENT_SCHEMA_VERSION) return { value: doc, report: [] };

  doc.schema_version = CURRENT_SCHEMA_VERSION;
  if (options.foldDevices !== true) return { value: doc, report: [] };

  const report: string[] = [];
  foldDocument(doc, report);
  return { value: doc, report };
}
```

要点：

- **默认行为完全不变**：`options.foldDevices !== true` 时直接 `return { value: doc, report: [] }`，与 P0 逐字相同，因此 P0 的 8 条迁移用例（原样保留、结构不同保留、幂等、纯净、坏数据不抛）一条没改、全部仍绿。
- **只折 v1**：折算放在 `version >= CURRENT_SCHEMA_VERSION` 的早退之后，已经是 v2 的文档不会被再折一次（迁移仍然幂等，第二次调用返回同一对象值、`report` 为空）。
- **三处都折**：`home`、`article`、`pages[].layout`；`pages` 用 `map` + `{ ...entry, layout }` 生成新页面对象，页面自身的 `id` / `title` / `status` 等字段原样带过（有测试钉住 `title` 不被顺手改掉）。
- **仍不是原文改写**：`doc` 是浅拷贝，`foldDeviceLayouts` 内部 `structuredClone` 后再返回全新对象，所以入参文档（含 `pages` 数组、每个 `page`、每份 `layout`）一个字节都不会被改。新加的纯净用例连 `pages[].layout` 的折算分支一起覆盖。
- **报告合并**：`foldDeviceLayouts` 直接把中文句子推进同一个 `report` 数组；页面标签取 `title`（缺省退回「页面」），这样 `report` 里能看出是哪一页被折了。`report` 目前仍由 `readCustomization` 丢弃，符合设计文档 §4.4「迁移报告 P1 配合确认弹窗再呈现」的口径，本任务没有越界去接弹窗。

### 1.2 读取路径显式打开折算（`apps/web/src/lib/customize.ts`，`readCustomization`）

```ts
// 折算现在安全了：渲染层已经求值 at（见 ScreenRenderer 的 applyDisplayOverrides），
// 折叠掉的手机/平板布局会以 at 覆盖的形式继续生效。
const migrated = migrateCustomization(config.customization, { foldDevices: true });
const raw = migrated.value as Partial<SiteCustomization>;
```

- 只有这一个调用点显式打开；`migrateCustomization` 的默认参数保持关闭，其它调用方（含测试）不会被动改行为。
- 保存路径没动：仍然写原始对象，迁移结果照旧在下一次保存 / `customizationSync` 缓存写回时落盘（P0 的既有约定）。

---

## 2. TDD 过程

1. **红**：先在 `apps/web/src/lib/migrate.test.ts` 追加 brief 的那条用例，另补 3 条（见下）。`npx vitest run src/lib/migrate.test.ts` → `Tests 3 failed | 13 passed (16)`：
   - `v1 文档在读取时把三端布局折算成 at…` — `expected undefined to deeply equal { mobile: { hidden: true } }`（第二个参数还不存在，`home.blocks[0].at` 为空）；
   - `首页之外的编排也折算…` — `expected [] to have a length of 3`（`report` 恒空）；
   - `读取路径显式打开了折算…` — `readCustomization` 读出来的 `at` 仍是 `undefined`。
   - 第 4 条（纯净用例）当时是「空跑通过」的，实现后才真正开始保护折算分支。
2. **绿**：`migrate.ts` 加 `MigrateOptions` / `foldDocument` + `customize.ts` 接线 → `src/lib/migrate.test.ts` 16 passed。
3. **被 P0 旧断言拦下（预期内）**：`src/lib/screenLayout.test.ts` 里 P0 写的 `配置归一化保留 device_split 与各设备编排` 断言「读入时三端编排原样留着」，而这正是本任务要反转的行为。改写见 §3。
4. **全量**：`npx vitest run` → `58 files / 637 tests passed`；`npm run typecheck` → 无输出、exit 0。

新增/改写的 5 条用例：

| 测试 | 守什么 |
| --- | --- |
| `v1 文档在读取时把三端布局折算成 at（渲染层已经求值 at）` | brief 原文：`at` 出现、`devices` 消失 |
| `首页之外的编排也折算：文章页与自定义页面，报告逐条带上页面标签` | 三处接线都生效；`report` 3 条、都提到「手机」、其中一条带页面标题「关于」；页面自身 `title` 不被改 |
| `打开折算时同样不修改调用方传进来的文档` | 浅拷贝 + `structuredClone` 的纯净性（含 `pages[].layout`） |
| `读取路径显式打开了折算：v1 的三端编排读进来就是 at` | `readCustomization` 真的传了 `{ foldDevices: true }`，且 `at` 活过归一化 |
| （改写）`读取路径折算三端编排：结构相同的设备副本变成 at 覆盖` / `结构对不上的设备编排读入时仍然保留` | 读路径的新契约：同结构 → 折成 `at`；结构不同 → 保留并留 `device_split` |

---

## 3. 超出 brief 文件清单的一处：`screenLayout.test.ts`

brief 列的是一改两文件 + 一个测试文件，但 `apps/web/src/lib/screenLayout.test.ts` 里 P0 留下的一条用例直接断言了本任务要反转的行为，不改它整个套件不可能绿：

```ts
// 旧（P0，已删）
it('配置归一化保留 device_split 与各设备编排', () => {
  expect(customization.home.device_split).toBe(true);
  // 折算推迟到渲染层开始求值 at 之后（P1），所以读入时三端编排必须原样留着；
  expect(customization.home.devices?.desktop?.blocks[0].title).toBe('桌面文案');
```

拆成两条（`screenLayout.test.ts:73`、`:93`）：

1. `读取路径折算三端编排：结构相同的设备副本变成 at 覆盖` —— 用同一批 `id` 的 desktop/mobile 树（mobile 只差 `hidden`），断言读出 `at = { mobile: { hidden: true } }`、`device_split` 与 `devices` 都不在了。即「读取路径折算了」的正面用例。
2. `结构对不上的设备编排读入时仍然保留（折算不敢动它）` —— 沿用原 `layoutWithDevices()` 数据。注意它用 `createBlock` 随机 id：mobile 那棵树是另建的块，`sameShape` 判否，所以**保留**（`device_split: true` 仍在），而 desktop 那份与 base 同引用 → 被丢掉。原来断言 `devices.desktop` 存在，现在断言它消失，并加注释说明为什么两组数据结果不同。`device_split: false` 时清空 `devices` 的那半段原样保留。

我认为这属于「行为反转必须同步的旧断言」，而不是新增需求；已按精确路径一并提交（`git add` 只加 4 个文件，未用 `git add -A` / `stash` / `checkout --`）。

---

## 4. 需要父级/评审决定的一个风险（本次未改，按「nothing more」留给后续）

`foldDeviceLayouts` 的判定只有**结构**（`sameShape`：id 与 children 形状），折叠进 `at` 的只有**展示层字段**（`DISPLAY_KEYS`：span / appearance / animation / hidden / custom_css / width / height）。于是存在这样一份 v1 文档：

> 手机那份 `devices.mobile.blocks` 与桌面**同 id、同嵌套**，但用户在手机端改过**文案/属性**（`title`、`props`）。

这种树会通过 `sameShape`，`diffDisplay` 却是空补丁 → 设备树被删除，而 `title` / `props` 差异**没有变成 `at`**，等于这部分内容在首次读取后就永久丢了（下一次保存还会落盘）。

这不是假想：`apps/web/src/pages/admin/ThemeBuilder.tsx:126` 的 `persistBlocks` 在 `device_split` 打开时把**整棵编辑树**写进 `devices[device].blocks`，`toggleSplit` 也是把当前树 `cloneBlocks` 给三端——v1 用户完全可能在手机端改过正文文案。

P0 的 `sameShape` 注释写着「只有此时折算才不改变任何人的布局」，对内容差异来说这句不成立。可选后续（**均未实现**，属于 P0 `foldDeviceLayouts` 的契约变更，不在 Task 6 范围）：

- 在 `foldLayout` 里再加一道「非展示层字段也相同」的判定，不成立就 `kept.push(设备名)` 并写报告（与「宁可多留一份，也不能错折」的既有注释一致）；
- 或者让 `readCustomization` 先把折算 `report` 冒泡到 P1 的迁移确认弹窗（设计文档 §4.4 已排期），至少让用户在落盘前看见「手机端有 N 处已折算」。

我只按 brief 打开了折算，没有改 `foldDeviceLayouts` 的语义。

---

## 5. 文件清单

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/lib/migrate.ts` | 新增 `MigrateOptions`、`pageLabel`、`foldDocument`；`migrateCustomization(raw, options = {})` 在 `foldDevices === true` 时折 `home` / `article` / `pages[].layout` 并合并 `report` |
| `apps/web/src/lib/customize.ts` | `readCustomization` 改为 `migrateCustomization(config.customization, { foldDevices: true })`，注释说明「at 已被渲染层求值，所以折算安全」 |
| `apps/web/src/lib/migrate.test.ts` | 追加 4 条用例（brief 的 1 条 + 三处接线/纯净性/读取路径 3 条），195 → 275 行 |
| `apps/web/src/lib/screenLayout.test.ts` | 改写 P0 那条「读入时原样保留」的用例为 2 条新契约用例（见 §3） |

共享工作树里另有大量与本任务无关的已修改/未跟踪文件（P0 其他批次），本次只提交上述 4 个精确路径。

## 6. 验收命令（逐字执行结果）

```bash
cd apps/web
npx vitest run src/lib/migrate.test.ts          # 3 failed | 13 passed（红，Step 2）
npx vitest run                                  # 58 files / 637 tests passed
npm run typecheck                               # tsc --noEmit，无输出
git add apps/web/src/lib/migrate.ts apps/web/src/lib/migrate.test.ts \
        apps/web/src/lib/customize.ts apps/web/src/lib/screenLayout.test.ts
git commit -m "feat(web): fold legacy split-device layouts now that at is rendered"   # 7ae7d2d
```

基线对齐：58 files / 632 → **58 files / 637**（+5 条用例，无删除、无跳过）。

---

## Fix: 折算可能丢内容

- **Commit:** `91f5a60` — `fix(web): never drop a device tree whose content differs from the base`
- **改动文件:** 只有 `apps/web/src/lib/migrate.ts`、`apps/web/src/lib/migrate.test.ts`（`git add` 精确路径，未用 `-A` / `stash` / `checkout -- .`）
- **对应风险:** 本文 §4 里记的那条「同 id 同嵌套、但 `title` / `props` 不同 → 内容被折掉」的静默丢数据；同时修掉「桌面编辑落在 `devices.desktop` 却拿 `layout.blocks` 快照当基础」的旧快照回退。

### 做了什么

1. **Defect A（内容不同不能折）**：新增 `CONTENT_KEYS = ['type', 'title', 'column', 'area', 'props']` 与递归的 `sameContent`（`props` 等字段用 `JSON.stringify` 深比，逐层比 `children`，深度上限处回答「证明不了相同」）。`foldDisplay` 的守卫从 `sameShape` 换成 `foldable`（= `sameShape && sameContent`），所以只要有一个节点内容不同，整端一点 `at` 都不写。
2. **`foldLayout` 的判定顺序**：先 `sameShape` → 报告「布局与桌面结构不同」；再 `sameContent` → 保留该设备树并报告「内容与桌面不同，保留为独立编排。」（沿用结构差异那条的句式，文案里带「内容」）。
3. **Defect B（基础编排取桌面实际编辑的那棵）**：新增 `foldBase()`，`devices.desktop?.blocks` 是数组就用它，否则退回 `layout.blocks`；两条路径都先 `structuredClone`，折算写的 `at` 仍然只落在新对象上（纯净性不变）。`devices.desktop` 的「与 base 同结构即丢弃」逻辑原样保留——base 现在就是它自己的拷贝，该分支依旧命中。
4. **未改**：深度上限（`MAX_BLOCK_DEPTH` 处一律判否）、幂等、`report` 数组约定、`MigrateOptions.foldDevices` 默认关闭、读取路径接线。

### 测试：按真实签名适配，并说明一处 fixture 调整

原 brief 给的样例假设 `foldDeviceLayouts` 返回 `{ value, report }`。实际导出是 `foldDeviceLayouts(layout, label, report): unknown`（`report` 是调用方传进来的数组），所以 `foldDeviceLayouts` 那几条按真实签名写：`const report: string[] = []; const folded = foldDeviceLayouts(..., '首页', report) as Record<string, unknown>;`，断言 `folded.devices` / `folded.blocks[0].at` / `report.join('')`。

第二条样例（`桌面编辑在 devices.desktop 里时以它为准`）的断言逐字保留，但 **fixture 里 mobile 也改成了 `title: '桌面新标题'`**。原因：样例原本给的是 `mobile: { blocks: [block('a')] }`（标题 `'a'`），它与新的桌面 base 内容不同 → 按本修复必须保留手机版树、`device_split` 仍为 `true`，于是「`home.device_split` 为 undefined」这条断言必然失败。这不是新 base 改掉的期望，而是 Defect A 的规则生效。为了让这条用例只考察「base 取谁」，把 mobile 改成与新桌面树完全相同的副本（纯冗余副本 → 应当被丢掉，`device_split` 清掉）；原样例里「桌面与手机内容不同」那种情形另开了一条用例 `桌面版自己改过内容、手机版又不一样：两边都保住`，断言桌面标题胜出、`devices.mobile` 保留、`device_split === true`、报告含「内容」。

新增 6 条用例（`migrate.test.ts` 15 → 21）：

| 测试 | 守什么 |
| --- | --- |
| `同结构但内容不同：不折算、保留设备树、写进报告` | 标题不同 → 设备树活着、base 上无 `at`、报告含「内容」 |
| `内容不同就整端不折算：展示层的差异也不写成 at（不留半折算的树）` | 内容不同时连 `hidden` 这种可折差异也不碰，避免「折了一半」 |
| `嵌套子区块的 props 不同同样算内容不同` | `sameContent` 递归到 `children`（`props.text` 桌面 vs 手机） |
| `桌面编辑在 devices.desktop 里时以它为准（不退回旧快照）` | base = desktop 内容；相同副本被丢、`device_split` 清掉 |
| `桌面版自己改过内容、手机版又不一样：两边都保住` | 新 base 下内容不同的手机版仍然保留（见上） |
| （既有用例全部保留，未改期望） | 58 files / 648 tests 全绿，无跳过 |

### 验证输出（从 `apps/web`）

```text
$ npx vitest run src/lib/migrate.test.ts
 ✓ src/lib/migrate.test.ts (21 tests) 56ms
 Test Files  1 passed (1)
      Tests  21 passed (21)

$ npx vitest run
 Test Files  58 passed (58)
      Tests  648 passed (648)
   Start at  09:15:04
   Duration  77.06s

$ npm run typecheck
> @practacu/web@0.1.0 typecheck
> tsc --noEmit
（无输出，exit 0）
```

基线 58 files / 637 → **58 files / 648**（+6 条用例，无删除、无跳过、无 `skip`）。
