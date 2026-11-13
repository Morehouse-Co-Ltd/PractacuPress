# Task 6 报告：体积预算、保存护栏与端到端验证

- 分支：`feat/page-builder-v2-p0`
- 提交：`b8a3a4f86924ba9a59adc9b5bfdb1f0932d9ade4`
  （`feat(web): enforce design volume budgets and guard saves at the block limit`）
- 状态：**DONE**（两处需要reviewer 知情的点见 §5：演示模式封面上传的既有 600 KB 提示与
  内联 64 KB 上限不一致；计划 Step 6 的第 3 步「媒体库选图」未加进 e2e，原因见 §5.3）

> 说明：`.superpowers/sdd/web-task-6-brief.md` 整篇是 mojibake（GBK 内容被当 UTF-8 读），
> 本次以 `docs/superpowers/plans/2026-11-02-page-builder-v2-p0-web.md` 的 `### Task 6`
> （第 1423–1576 行）为需求原文，并按任务上下文里的四条现状修正执行。

---

## 1. 改了什么

### `apps/web/src/lib/customize.ts`

- 在 `normalizeMediaUrl` 之后新增「体积预算（规格 §4.5）」小节：
  ```ts
  export const PROPS_MAX_BYTES = 8192;
  export const DESIGN_SOFT_LIMIT_BYTES = 524288;
  export const COVER_DATA_URL_MAX = 65536;

  function byteLength(value: unknown): number            // TextEncoder + JSON.stringify，异常回退 0
  export function designVolumeReport(customization: unknown): { bytes: number; soft: boolean }
  function capPropBytes(out: BlockProps): BlockProps      // 超过 PROPS_MAX_BYTES 的键整条丢弃
  ```
- `normalizeBlockProps` 的两个出口（未识别类型分支、已知类型分支）都改成 `return capPropBytes(out)`。
  计划只写了「在结尾加裁剪」，实际有两条 `return out`（未识别类型的区块走的是早退分支），
  两条都收，否则「从新版本导入的未知区块」会绕过预算。
- 封面归一化改用 `COVER_DATA_URL_MAX`（原 `MAX_COVER_DATA_URL_CHARS = 1_200_000`）：
  - 删除 `MAX_COVER_DATA_URL_CHARS`，`normalizeCoverUrl` 的整条长度门与 data URL 分支都用
    `COVER_DATA_URL_MAX`，超限整条丢弃（不截断，截断就是坏图）；
  - `coverUrlError` 的超长分支同样改用 `COVER_DATA_URL_MAX`，文案改成
    `图片太大：内联封面图上限 64 KB，请换一张更小的图片。`（原 600 KB 提示与实际上限不符）。

### `apps/web/src/pages/admin/ThemeBuilder.tsx`

- `blockTree` 的 import 补 `MAX_BLOCKS`、`countBlocks`。
- 在 `persistBlocks` 之前新增 `guardBudget(next): boolean`，`persistBlocks` 第一行
  `if (!guardBudget(next)) return;`。
- **与计划代码的唯一差异**：toast API 不是 `toast.error(...)`，本项目是
  `useToast(): { push(tone, message, detail?) }`（`apps/web/src/lib/toast.tsx`），
  所以写成 `toast.push('error', t('这份编排有 {count} 个区块，超过上限 {limit} 个。请先删掉一些再保存。', { count: total, limit: MAX_BLOCKS }))`。

### `apps/web/src/lib/i18n/dict/fragments/*`

- `pages_admin_ThemeBuilder.ts`：新增保存护栏文案 + 英文。
- `lib_customize.ts`：封面上限文案换键（中文原文作 key）+ 英文。
  `npm run i18n:audit` 的「待迁移」计数仍是 191（本次新增的两条都包了 `t()`）。

### `apps/web/src/lib/volumeBudget.test.ts`（新建）

计划给的 3 个用例 + 我补的 1 个「越过 512 KB 软警告线时 `soft === true`」；
另外把前两个用例的断言做实了（计划里那两条其实恒真）：
- 封面用例额外断言 `normalizeCoverUrl(huge) === ''`、小图不被丢；
- props 用例额外断言 `normalizeBlockProps('image', { src: 9 KB data URL, alt: '图' })`
  丢掉 `src`、保留 `alt`。
  （`text` 区块的 `body` 有 4000 字符上限，单标量永远撑不到 8 KB；真正会撑爆预算的是
  `media` 内联图与 repeater。）

### `apps/web/src/lib/covers.test.ts`（计划外，必要）

`MAX_COVER_DATA_URL_CHARS` → `COVER_DATA_URL_MAX`（2 处构造 + 2 处断言），
`超长图片提示 600 KB 以内` → `超长图片提示 64 KB 以内`。行为按规格改了，断言必须跟着改。

### `apps/web/scripts/e2e-builder-blocks.mjs`

- 新增 `addButtonRow(index, label, link)`：在 `.builder-inspector .itemlist` 里点「添加按钮」，
  等 `[aria-label="按钮 第 N 条 文字"]` 出现后用原生 setter + input/change 填文字与链接。
- B 段重写：点组件库「按钮」之后**先补两个按钮**（`立即阅读→/articles`、`关于我们→/about`），
  再断言预览 iframe 里 `.pp-action-btn` 数 ≥ 2；原来的「加完立刻有 `.pp-action-btn`」断言已不可能成立
  （按钮区块默认 `buttons: []`）。
- F/CONFIG 段新增：配置里 `props.buttons` 长度为 2、文字与链接逐项匹配。
- G/PERSIST 段新增：刷新后配置里两个按钮仍在；`.pp-action-btn` 计数从 `> 0` 收紧成 `>= 2`。
- 文档头注释同步更新；其余断言（组件库负向断言、5 项外观、计算样式、截图）原样保留。

---

## 2. red / green

### red（实现之前）

```
$ npx vitest run src/lib/volumeBudget.test.ts
 Test Files  1 failed (1)
      Tests  4 failed (4)
TypeError: (0 , designVolumeReport) is not a function
```

### green（实现之后）

```
$ npx vitest run src/lib/volumeBudget.test.ts src/lib/covers.test.ts
 ✓ src/lib/volumeBudget.test.ts (4 tests) 10ms
 ✓ src/lib/covers.test.ts (25 tests) 12ms
 Test Files  2 passed (2)
      Tests  29 passed (29)
```

### 全量闸门（`apps/web`）

```
$ npm run typecheck
> tsc --noEmit          # 0 错误，无输出

$ npx vitest run
 Test Files  52 passed (52)
      Tests  567 passed (567)
（任务前基线 51 文件 / 563 测试；+1 文件 = volumeBudget.test.ts，+4 测试）

$ npm run i18n:audit
覆盖率 96.2% · 已包裹 4813 · 待迁移 191 · 完全双语 91/165
（新增两条文案都包了 t()，待迁移计数与基线一致）

$ npx vitest run src/lib/i18n/coverage.test.ts
 ✓ src/lib/i18n/coverage.test.ts (3 tests)

$ npm run build
✓ built in 14.99s
dist 合计 1,765,433 B → 1,782,088 B（+16,655 B，约 +0.9%）
（注：这个增量包含共享工作区里其它会话尚未提交的改动，不全是本任务的产物；
 本任务新增运行时代码只有 ~30 行 + 4 个常量，远低于计划给的 40 KB 预算。）
```

### 端到端（真跑，不是推断）

环境：本机 Chrome 存在（`C:/Program Files/Google/Chrome/Application/chrome.exe`），
`node scripts/serve.mjs --port 8099` 提供 `dist`，脚本用 CDP 驱动无头 Chrome。

```
$ node scripts/e2e-builder-blocks.mjs
SETUP  PASS  3/3
BUILDER  PASS  2/2
BUTTON  PASS  3/3
PALETTE  PASS  2/2
APPEARANCE  PASS  14/14
CONFIG  PASS  5/5
PERSIST  PASS  8/8

PASS 37 / FAIL 0

截图 7 张（apps/web/.tmp/shots-builder/）：
  00-setup-welcome / 01-builder-initial / 02-button-added / 03-palette-no-mindmap /
  04-appearance-panel / 05-button-appearance / 06-after-reload-button
```

关键输出片段：

```
PASS [BUTTON] 属性面板里填好两个按钮（文字 + 链接）  · 立即阅读→/articles，关于我们→/about
PASS [BUTTON] 预览 iframe 的按钮区块渲染两个 .pp-action-btn  · 按钮=2
PASS [CONFIG] 配置里按钮区块保存了两个按钮（文字 + 链接）  · buttons=[{"label":"立即阅读","link":"/articles","style":""},{"label":"关于我们","link":"/about","style":""}]
PASS [PERSIST] 刷新后配置里两个按钮仍在（文字 + 链接）
PASS [PERSIST] 刷新后预览 iframe 仍渲染两个 .pp-action-btn  · 按钮=2
```

---

## 3. 提交范围（共享工作区）

`git show --stat HEAD` 只有 7 个路径：

```
 apps/web/scripts/e2e-builder-blocks.mjs                               | 1151 ++++++++++++
 apps/web/src/lib/covers.test.ts                                       |   12 +-
 apps/web/src/lib/customize.ts                                         |   64 +-
 apps/web/src/lib/i18n/dict/fragments/lib_customize.ts                 |    4 +-
 apps/web/src/lib/i18n/dict/fragments/pages_admin_ThemeBuilder.ts      |    3 +
 apps/web/src/lib/volumeBudget.test.ts                                 |   43 +
 apps/web/src/pages/admin/ThemeBuilder.tsx                             |   31 +-
```

- `ThemeBuilder.tsx` 与 `pages_admin_ThemeBuilder.ts` 都带着**别的会话**未提交的改动
  （「收起/展开面板」按钮、文章页自动放「文章内容」占位符、`useRef` import），
  按任务要求用 `git diff` → 只挑自己的 hunk → `git apply --cached`，两个文件提交后
  仍是 `MM`（我的已入库，别人的还在工作区）。
- `apps/web/scripts/e2e-builder-blocks.mjs` 在本分支上原本是 untracked（Task 1–5 没提交过它），
  所以这次是整文件新增（1151 行）。
- **提交事故与修正（必须知情）**：第一次 `git commit` 时，共享 index 里被并发会话临时
  `git add` 了 6 个 API 文件（gzip 中间件、`cache_control_test.go`、`router.go`），
  我的提交把它们一起带走了（`7f3e59a`）。发现后我没有用 `reset`/`stash`，而是：
  1. 用 `git read-tree <parent>` + `git update-index --cacheinfo`（`GIT_INDEX_FILE` 指向
     临时索引）重建了一棵只含我这 7 个 blob 的树；
  2. `git commit-tree` + `git update-ref refs/heads/... <new> <old>`（CAS，旧值不匹配就失败）；
  3. 只动了 ref，没碰共享 index，那些 API 文件已回到对方「已 staged / 已修改」的待提交状态。
  当前 HEAD = `b8a3a4f`（父提交 `cc0409a`），孤儿对象 `7f3e59a` 仍在本地对象库里，未被引用。
  事后那个并发会话在 `b8a3a4f` 之上正常提交了 `2edee60 perf(api): gzip JSON responses and
  cache public media at the edge`，内容正是那 6 个 API 文件——说明重写没有丢掉对方的工作。

---

## 4. 计划说错的地方 / 与计划的偏差

1. **`toast.error(...)` 不存在**。真实 API 是 `useToast().push(tone, message, detail?)`。
   任务上下文提前点到了这一点，按真实形状写。
2. **计划给的 3 个测试用例有 2 条恒真**：
   `designVolumeReport` 只做 `JSON.stringify` 计数，不做归一化，所以
   「64 KB 封面」那条（≈65.5 KB < 512 KB）和「8 KB props」那条（≈8.4 KB < 9216）
   在**没有实现**时也会通过。我保留了两条原断言（不违背计划），并补了真正会红的
   `normalizeCoverUrl` / `normalizeBlockProps` 断言，否则这个测试文件起不到护栏作用。
3. **「在 `normalizeBlockProps` 结尾加裁剪」不够**：该函数在「未识别区块类型」时提前
   `return out`，只改结尾会让未知区块绕过预算。两条出口都套了 `capPropBytes`。
4. **`MAX_COVER_DATA_URL_CHARS` 不是只有封面归一化在用**：
   `apps/web/src/components/ArticleCoverPanel.tsx` 的演示上传提示、`coverUrlError` 都围绕
   这个常量。按规格把上限降到 64 KB 后，`covers.test.ts` 里「600 KB」断言必须跟着改
   （计划没提，属于必要差异，见 §5.1）。
5. **计划 Step 6 的第 3 步（图片块 → 从媒体库选择 → 断言 `img[src*="/api/v1/media/"]`）
   没有加**。原因见 §5.3。

---

## 5. 需要 reviewer 决定的残留问题

### 5.1 演示模式封面上传的提示与实际内联上限不一致（我引入的语义收紧）

- 规格 §4.5 明确要求 `covers[].url` 的 data URL 上限 64 KB（现状 1.2 MB），落点是
  `customize.ts` 归一化。做了之后：**演示模式下上传的封面图（`backend.upload` 返回 data URL）
  只要超过约 48 KB 原图，就会在 `normalizeCoverUrl` 被拒**，`ArticleCoverPanel` 走到
  `throw t('上传结果不能用作封面地址。')`。
- 但 `ArticleCoverPanel.tsx` 仍写着 `DEMO_IMAGE_LIMIT = 600 * 1024`，两处文案还在说
  「600 KB 以内」。也就是说：**演示模式封面上传的可用体积从 600 KB 掉到 ~48 KB，
  提示还停在 600 KB**。
- 该组件不在本任务的计划文件清单里，我没有动它。建议的收尾（单独一个小提交）：
  `DEMO_IMAGE_LIMIT` 改成 `48 * 1024`，并把 `components_ArticleCoverPanel.ts` 里
  「请选择 600 KB 以内的图片」「建议 600 KB 以内」两处文案改成 48 KB。
  （真实后端上传返回 `/api/v1/media/{id}`，不受影响。）

### 5.2 `designVolumeReport` 目前只有导出 + 测试，没有 UI 消费

计划 Step 4 只给了区块数护栏（`countBlocks` / `MAX_BLOCKS`），没有要求把软警告接到界面；
`ThemeBuilder` 里每次 history 变化都会 `persistBlocks`，直接弹 toast 会在超限后反复刷屏，
所以本任务没有加「设计体积超过 512 KB」的提示条。规格 §4.5 的「编辑器顶部条提醒」属于 UI 收尾，
`designVolumeReport` 已就绪可直接用。

### 5.3 e2e 没有覆盖「媒体库选图」

计划 Step 6 第 3 步的断言是 `img[src*="/api/v1/media/"]`，但本脚本跑的是**演示模式**
（安装向导选「演示数据」，`backend.upload` 返回 data URL），演示媒体库里的地址不是
`/api/v1/media/{id}`；把它写进脚本会得到一条与环境不符的断言。按任务上下文的指示，
本次只补了按钮表单路径（picker/form 已在单测里覆盖），其余断言原样保留。
如果需要在 e2e 里覆盖选图，建议断言「点『从媒体库选择』→ 弹层出现 → 选中后输入框非空」，
而不是写死后端 URL —— 这需要先确认演示媒体库的种子数据，留作后续。

### 5.4 保存护栏没有在浏览器里被触发过

`MAX_BLOCKS = 200`，e2e 里造 201 个区块不现实，所以 `guardBudget` 的「拒绝落盘 + 弹错」
只有类型检查与代码审查覆盖。归一化侧的行为（`MAX_BLOCKS` 截断）在 Task 2 已有单测。

---

## 6. 本次触碰的文件清单

计划内：
- `apps/web/src/lib/customize.ts`
- `apps/web/src/pages/admin/ThemeBuilder.tsx`（只提交我的 hunk）
- `apps/web/src/lib/i18n/dict/fragments/pages_admin_ThemeBuilder.ts`（只提交我的 hunk）
- `apps/web/src/lib/i18n/dict/fragments/lib_customize.ts`
- `apps/web/src/lib/volumeBudget.test.ts`（新建）
- `apps/web/scripts/e2e-builder-blocks.mjs`

计划外（必要）：
- `apps/web/src/lib/covers.test.ts`（常量改名 + 64 KB 文案断言）

---

## 7. 复现命令

```bash
cd apps/web
npx vitest run src/lib/volumeBudget.test.ts      # 4 passed
npm run typecheck                                 # 0 error
npx vitest run                                    # 52 files / 567 tests passed
npm run i18n:audit                                # 96.2%，待迁移 191（基线）
npx vitest run src/lib/i18n/coverage.test.ts      # 3 passed
npm run build                                     # +16,655 B

# e2e（本机已验证可跑）
node scripts/serve.mjs --port 8099 &
node scripts/e2e-builder-blocks.mjs               # PASS 37 / FAIL 0
```
