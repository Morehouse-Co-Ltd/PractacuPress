# Task 5 报告：media 属性类型与媒体库选择器

- 分支：`feat/page-builder-v2-p0`
- 提交：`93311f1303a5475f261c0e664a7954abaee27473`
  （`feat(web): add the media property type and a media library picker`）
- 状态：**DONE**（唯一保留意见见「计划说错的地方」第 4 条：演示模式下 `data:` 资产会被白名单丢弃，是既有渲染限制，不是本次引入的回归）

> 说明：`.superpowers/sdd/web-task-5-brief.md` 整篇是 mojibake（GBK 内容被当 UTF-8 读），
> 本次以 `docs/superpowers/plans/2026-11-02-page-builder-v2-p0-web.md` 的 `### Task 5`
> （第 1169–1419 行）为需求原文。内容与 brief 的意图一致。

---

## 1. 改了什么

### `apps/web/src/lib/blocks.ts`
- `PropType` 联合类型追加 `| 'media'`（带注释）。
- `image` 区块 schema 的 `src` 从 `type: 'text'` 改成 `type: 'media'`，并补 `hint`：
  `可以从媒体库选，也可以填外部图片地址。`
- 默认值不变（`src: ''`）。

### `apps/web/src/lib/customize.ts`
- 新增导出 `normalizeMediaUrl(value: unknown): string | undefined`：只放行
  `/api/v1/media/…`、`/` 开头的站内路径、`http(s)://` 绝对地址，长度限制 2048；
  `data:`、`javascript:`、相对路径、空串一律 `undefined`。
- `normalizeBlockProps` 的字段循环里、`repeater` 分支之后新增 `media` 分支。
  **与计划的差异**：空串（或纯空白）保留成 `''`，再走白名单。

### `apps/web/src/components/builder/MediaPicker.tsx`（新建）
`<MediaPicker open onClose onPick />`：`Modal` + 资产缩略图网格，只列
`scan_status === 'clean'` 且 `url` 非空的资产；加载 / 失败 / 空库三种文案都走 `t()`。

### `apps/web/src/components/builder/BlockProps.tsx`
- `PropControl` 顶部加 `const [pickerOpen, setPickerOpen] = useState(false)`，
  react import 补 `useState`，ui import 补 `Button`，并 import `MediaPicker`。
- `repeater` 分支之后（`itemlist` 之前）新增 `schema.type === 'media'` 分支：
  `Field` 里一个 `Input` + 「从媒体库选择」`Button`，下面挂 `MediaPicker`。

### `apps/web/src/styles.css`
`+31` 行：`.media-field`、`.media-picker-grid`、`.media-picker-item`（含 `img` / `span`）。
放在 `.itemlist-field input[type="color"]` 之后、`/* 令牌 */` 之前。计划里的单行写法按
该文件既有风格拆成了多行，选择器与取值完全一致。

### `apps/web/src/lib/mediaProps.test.ts`（新建）
计划里的 3 个用例 + 1 个我补的守护用例「image 的空 src 读入后仍然保留」。

### i18n
- 新建 `apps/web/src/lib/i18n/dict/fragments/components_builder_MediaPicker.ts`：
  `从媒体库选择`、`正在读取媒体库…`、`读不到媒体库，检查登录状态或后端是否在线。`、
  `媒体库还是空的，先去「媒体」页上传图片。`（`取消` 已在 `common.ts`）。
- `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts` 追加
  `可以从媒体库选，也可以填外部图片地址。`

---

## 2. red / green

### red（Step 2，实现之前）

```
$ npx vitest run src/lib/mediaProps.test.ts
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

典型失败：

```
- Expected: undefined
+ Received: "data:image/png;base64,AAAA"
 ❯ src/lib/mediaProps.test.ts:22:23        // image 区块的 src > 走 media 白名单

 FAIL  src/lib/mediaProps.test.ts > image 区块的 src > 空 src 读入后仍然保留
AssertionError: expected '   ' to be ''
```

两个 `normalizeMediaUrl` 用例此时直接抛错——`customize.ts` 还没有这个导出（`media` 分支不存在，
`data:` 仍被当普通字符串放行，这正是第 3、4 个用例断言到的现象）。

### green（实现之后）

```
$ npx vitest run src/lib/mediaProps.test.ts src/lib/repeaterProps.test.ts
 ✓ src/lib/mediaProps.test.ts (4 tests)
 ✓ src/lib/repeaterProps.test.ts (9 tests)
 Test Files  2 passed (2)      Tests  13 passed (13)
```

`repeaterProps.test.ts` 一起跑是因为它里面那条「每个区块的默认 props 经过归一化后原样保留
（读→写幂等）」正好是空串分支的直接守卫。

### 全量

```
$ npx vitest run
 Test Files  51 passed (51)
      Tests  559 passed (559)
```

（基线 50 文件 / 555 测试 → 新增 1 文件 / 4 测试，其余全绿。）

```
$ npm run typecheck          # tsc --noEmit，0 错误
$ npx vitest run src/lib/i18n/coverage.test.ts
 ✓ src/lib/i18n/coverage.test.ts (3 tests)   Tests 3 passed (3)
$ npm run i18n:audit
扫描文件      165
已包裹文案    4812
待迁移文案    209
覆盖率        95.8%
完全双语文件  91 / 165
```

`i18n:audit --all` 的待迁移清单里**没有** `MediaPicker.tsx` / `BlockProps.tsx` /
`lib/blocks.ts`——本次新增文案全部走 `t()` 且都有英文；209 条是仓库既有的其他文件欠账。

---

## 3. 提交范围（共享工作区）

工作区有其他会话的未提交改动，所以**没有**按计划的 `git add <全部路径>` 一把梭：

- 完全属于本次的文件整文件入库：`blocks.ts`、`customize.ts`、`BlockProps.tsx`、
  `MediaPicker.tsx`、`mediaProps.test.ts`、`components_builder_MediaPicker.ts`。
- `styles.css` 与 `lib/i18n/dict/fragments/lib_blocks.ts` 里有别人未提交的 hunk
  （例如 `lib_blocks.ts` 的「按钮 / 文章内容占位符」整段、`styles.css` 里 +395 行的
  另一处样式块）。这两个文件用 `git diff -U3` 抠出我这一条 hunk，写临时 patch 后
  `git apply --cached` 只把这一段放进暂存区；工作树里别人的改动原样保留（提交后
  `git status` 仍显示这两个文件 modified，diff 里只剩别人的 hunk）。
- 全程没有 `git add -A` / `git add .` / `git stash` / `git checkout -- .`。

提交内容：8 files changed, 216 insertions(+), 3 deletions(-)。

---

## 4. 计划说错的地方 / 与计划的偏差

1. **`useBackend()` 没有 `api` 字段。**
   计划写的是 `backend.api.listAssets()`；实际 `apps/web/src/lib/backend.tsx` 的
   `useBackend(): Backend`，`listAssets()` 直接在 `Backend` 上（`Backend` 接口第 173 行，
   `HttpBackend` / `DemoBackend` 各自实现）。已改成 `backend.listAssets()`。

2. **`components/ui` 是一个文件，不是目录。**
   `apps/web/src/components/ui.tsx`。`Modal` 的真实 props 是
   `open / title / description? / onClose / children? / footer? / width?`（289–305 行），
   计划里的用法（`open`/`title`/`onClose`/children）正确，无需改动。
   顺带确认 `Button` 支持 `variant="secondary" size="sm"`。

3. **`Interfaces` 段与 `Step 5` 自相矛盾。**
   Interfaces 写「Produces: `<MediaPicker value={string} onChange={...} />`」，
   但 Step 5 的代码是 `open / onClose / onPick`。按 Step 5 的具体代码实现（它是唯一
   可执行的那份）。

4. **`data:` 一律拒绝 vs 演示模式（唯一保留意见）。**
   演示后端的上传把文件读成 `data:` URL（`lib/demo.ts` 的 `upload()` → `FileReader.readAsDataURL`），
   于是演示模式下从媒体库挑一张图，值会被 `normalizeMediaUrl` 丢掉。
   需要说明的是：**这不是本次引入的回归**——`image` 区块的渲染本来就过
   `safeUrl()`（`components/blocks/MediaBlocks.tsx:62`），而 `safeUrl` 早就不放行
   `data:`。所以演示模式里这类图片在改动前也渲染不出来，媒体库选择器只是把这个既有
   限制暴露到编辑路径上。真要修，方向是演示后端给媒体资产一个可放行的地址（或让
   `normalizeMediaUrl` 按 `normalizeCoverUrl` 那样对 `data:image/*` 设体积上限），
   但那与本节「`data:` 一律拒绝、免得撑爆 1 MiB 设计预算」的设计决定冲突，属于
   计划层面的取舍，留给 Task 6 / 后续任务决定。

5. **空串必须保留（计划漏了）。**
   计划只写「`media` 非法值返回 `undefined`」，如果照抄，`image` 的默认 `src: ''`
   会被删掉，`repeaterProps.test.ts` 的「默认 props 归一化后原样保留」这条会红。
   所以 `media` 分支对「空串 / 纯空白」显式写回 `''`（与 `repeater` 保留 `[]` 同一套
   理由：归一化只该删坏键，不该让读一次少一个键），并补了一条测试守住它。

6. **计划示例是单行 CSS。**
   该文件既有风格是多行声明，按文件风格排版；属性值一字未改。

7. 计划 Step 6 说「放在 `repeater` 分支之后」，实际插在 `repeater` 之后、`itemlist` 之前
   （`itemlist` 也早于普通标量分支，media 与它们并列，语义一致）。

---

## 5. 本次触碰的文件清单（含计划外）

计划内的 6 个：
- `apps/web/src/lib/blocks.ts`
- `apps/web/src/lib/customize.ts`
- `apps/web/src/components/builder/MediaPicker.tsx`（新建）
- `apps/web/src/components/builder/BlockProps.tsx`
- `apps/web/src/lib/mediaProps.test.ts`（新建）
- `apps/web/src/styles.css`

计划外的 2 个（i18n 硬门禁要求）：
- `apps/web/src/lib/i18n/dict/fragments/components_builder_MediaPicker.ts`（新建）
- `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts`（只加 2 行）

未触碰、仍属其他会话的未提交改动（仅记录，未 stage）：`MediaBlocks.tsx`、
`components_builder_BlockProps.ts`、`ArticleBlocks.tsx`、`styles/articleContent.css` 等。

---

## 6. 复现命令

```bash
cd apps/web
npx vitest run src/lib/mediaProps.test.ts      # 4 passed
npx vitest run src/lib/i18n/coverage.test.ts   # 3 passed
npm run i18n:audit                             # 本次文件 0 待迁移
npm run typecheck                              # 0 错误
npx vitest run                                 # 51 files / 559 tests passed
```

---

## Fix: 媒体白名单两条

评审的两条 Important 在本节处理，提交 `6ae02d2`（分支 `feat/page-builder-v2-p0`）。

### 1. 协议相对地址（`//evil.com/x.png`）

`normalizeMediaUrl` 原来只要 `startsWith('/')` 就放行，`//` 开头的值因此被存进配置，
但渲染层 `safeUrl()`（`lib/safeUrl.ts`）明确挡掉 `//`，两份判定不收敛：存得进去、画不出来。
现在站内路径分支要求 `startsWith('/') && !startsWith('//')`，与 `safeUrl` 同一条规则。
`/img/a.png`、`/api/v1/media/abc` 不受影响。

### 2. 演示模式的内联图片

演示后端的上传把文件读成 data URL，原白名单拒绝所有 `data:`，于是演示模式选中一张图
等于没选。现在只放行**内联图片**：`data:image/` 开头、含 `;base64,`、总长 ≤ 65536 字符
（`MAX_INLINE_MEDIA_CHARS`，约 48 KB 图片，1 MiB 设计预算守得住）。`data:text/…`、
不带 base64 的 `data:image/svg+xml,…`、超大图片仍然拒绝。函数保持全量、无副作用。

### 3. 顺带改了两条既有断言（必要）

放行小体积内联图片后，`mediaProps.test.ts` 里两条老断言的前提不再成立，继续留着就会红，
按新语义把输入换成仍然非法的那种（语义不变：非图片 data URL 一律丢）：

- 「拒绝 data URL、javascript 与相对路径」→ 用例名改为「拒绝**非图片** data URL、…」，
  输入换成 `data:text/html;base64,AAAA`。
- 「image 区块的 src 走 media 白名单」→ 输入换成 `data:text/html;base64,AAAA`，
  仍断言 `props.src` 为 `undefined`。

新增的 `describe('normalizeMediaUrl 安全边界')` 四条（协议相对、64 KB 内联放行、
超大内联拒绝、非图片 data URL / 非字符串 / 超长站内路径拒绝）按评审给的原样加入。

### 4. 提交范围（共享工作区）

`customize.ts` 与 `mediaProps.test.ts` 在开工时都**没有**其他会话的未提交 hunk
（`git status` 里两个文件均干净），所以直接 `git add <这两个路径>` 整文件入库，
没有用 `git diff` + `git apply --cached` 抠 hunk，也没有 `git add -A` / `git stash` /
`git checkout -- .`。提交内容：2 files changed, 46 insertions(+), 8 deletions(-)。

### 5. 复现输出

```bash
cd apps/web
npx vitest run src/lib/mediaProps.test.ts src/lib/repeaterProps.test.ts
#  ✓ src/lib/mediaProps.test.ts (8 tests)
#  ✓ src/lib/repeaterProps.test.ts (9 tests)
#  Test Files  2 passed (2) / Tests  17 passed (17)

npx vitest run
#  Test Files  51 passed (51)
#       Tests  563 passed (563)          （559 + 新增 4 条）

npm run typecheck
#  > tsc --noEmit    （0 错误）
```

### 6. 仍未闭合的一点（超出本任务范围）

渲染层 `components/blocks/MediaBlocks.tsx` 的 `src` 仍走 `safeUrl()`，而 `safeUrl` 不放行
`data:`。也就是说白名单这边已经收敛到「接受演示模式的内联图片」，但画面上仍然不会显示——
要真正修好演示模式的预览，还得让渲染层对 `media` 属性放行限长 `data:image/*`
（或演示后端改给一个可放行的地址）。本次只按任务边界改了 `customize.ts` 与测试。
