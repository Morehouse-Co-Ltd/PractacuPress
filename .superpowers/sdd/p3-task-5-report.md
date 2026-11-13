# P3 Task 5 收口报告（2026-11-03）

- **分支**：`feat/page-builder-v2-p0`
- **状态**：**GREEN** —— 四步验证全绿，§15 已写入，收尾提交已落地。
- **提交**：`294dba33ae2df0568fcac0022afbe475f30ed02e`（`docs: record what P3 shipped`），
  只含两个文件：设计文档 §15 追加（156 行纯追加）与 e2e 脚本的 P3 段（+347/−1）。
- **工作树**：与其它会话共用；全程只用精确路径 `git add`，未用 `-A` / `stash` / `checkout -- .`。

## 1. Go（仓库根）

命令与真实输出（`go1.26.0 windows/386`）：

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `go build ./apps/api/...` | **0** | 无输出 |
| `go test ./apps/api/...` | **0** | 全部包 `ok`，无 `FAIL`；`internal/auth` 10.683s、`internal/site` 6.455s、`internal/infrastructure/authstore` 6.803s 最慢 |

`ent*`、`cmd/migrate`、`cmd/seed` 等包为 `[no test files]`，属正常。

## 2. Web（`apps/web`）

| 命令 | 退出码 | 真实输出 |
| --- | --- | --- |
| `npx vitest run` | **0** | `Test Files 70 passed (70)` / `Tests 921 passed (921)`，Duration 78.81s |
| `npm run typecheck` | **0** | `tsc --noEmit`，无输出（0 错误） |
| `npm run build` | **0** | `✓ 347 modules transformed.`，`✓ built in 5.15s`（仅 chunk >500 kB 的常规警告） |

构建产物（`dist/assets`，5 个文件）：

```
index-B5OjfXaU.css      230,418 B  (gzip  38,913)
index-B9PnhXNY.js     1,318,695 B  (gzip 423,186)
react-iatO0Ots.js       221,715 B  (gzip  68,821)
ThemeBuilder-BcrterOd.js 50,099 B  (gzip  16,670)
router-CCvbZSB8.js       39,130 B  (gzip  14,093)
```

## 3. 体积增量（P3 单独的口径）

量法与 P2 收尾一致：`node .tmp/dist-size.mjs dist/assets`（逐文件 `zlib.gzipSync` level 9 求和）。

- P2 的构建产物没有留档（`dist` 已被后续构建覆盖），用的基准是 §14.3 的记录值
  **1,841,330 B raw / 555,842 B gzip**。
- 另核对了 `dist-pre-p2/assets`（P1 收尾留档）复量为 **1,794,500 B raw**，与 §14.3 的记录
  逐字节一致，说明量法没有漂移。

| 口径 | P2 收尾 | P3 收尾 | **P3 增量** |
| --- | --- | --- | --- |
| assets raw | 1,841,330 B | 1,860,057 B | **+18,727 B（+18.3 KiB）** |
| assets gzip | 555,842 B | 561,683 B | **+5,841 B（+5.7 KiB）** |
| CSS（raw） | 227,999 B | 230,418 B | +2,419 B |
| 主 JS（raw） | 1,303,277 B | 1,318,695 B | +15,418 B |
| 其余 chunk（raw） | 310,054 B | 310,944 B | +890 B |

**结论：gzip +5,841 B ≈ 5.7 KiB，在 P3 的 ≤10 KB gzip 预算内（约 57%）。**

限定条件（必须一起读）：工作树是多会话共用的，`styles.css` 与 `index.js` 含并发会话尚未
提交的代码（`git status` 里 `apps/web/src/**` 有大量他人改动），所以这是 P3 增量的**上界**，
不是精确归因。

## 4. e2e（`node scripts/e2e-builder-blocks.mjs`）

**运行环境可实现**：`npm run build` 产物 + `PP_WEB_PORT=8099 node scripts/serve.mjs`
（静态服，`PP_WEB_PORT` 方式避免改写 `.runtime/web.json`），Chrome 走脚本自带的
`C:/Program Files/Google/Chrome/Application/chrome.exe`。

### 4.1 基线（改脚本之前，未加 P3 段）

```
PASS 49 / FAIL 0        （SETUP 3、BUILDER 2、BUTTON 3、UTILITY 12、PALETTE 2、
                          APPEARANCE 14、CONFIG 5、PERSIST 8）
截图 10 张 → apps/web/.tmp/shots-builder/
```

与 P2 收尾记录的 49 一致，说明起点没有被并发会话改动破坏。

### 4.2 加 P3 段之后（交付状态）

```
================ 汇总 ================
SETUP       PASS  3/3
BUILDER     PASS  2/2
BUTTON      PASS  3/3
UTILITY     PASS  12/12
PALETTE     PASS  2/2
APPEARANCE  PASS  14/14
CONFIG      PASS  5/5
PERSIST     PASS  8/8
P3          PASS  15/15

PASS 64 / FAIL 0
```

- 原有 8 段 **一条未改**，49 条断言全部保留且仍通过；新增 `[P3]` 段 15 条。
- 截图 **14 张**，目录 `apps/web/.tmp/shots-builder/`；新增 4 张：
  `07-query-block.png`、`08-anchor-nav.png`、`09-contact-form.png`、`10-contact-form-sent.png`。
- 新增断言覆盖：
  - `content-query`：组件库可追加 → 面板把条数改成 3 → iframe 里画出 3 张
    `.pp-article-card`（标题实测「评论嵌套收窄到三层 / 独立出版的账本 / 还有人用 RSS 读我们吗？」），
    且容器是 `.pp-article-grid.is-grid`（与文章组件共用卡片样式）。
  - `anchor-nav`：属性面板给按钮区块填锚点 `quick-start` → 目录渲染 `<nav aria-label="本页目录">`
    → 链接 `#quick-start(按钮)` → **每条链接都指得着页面上的 `id`**（`resolved=[true]`、
    `section#quick-start=true`，没有死链）。
  - `contact-form`：姓名 / 回信邮箱 / 留言三字段 + 提交按钮（默认「发送」）、蜜罐
    `website` 存在且 `tabindex=-1`、演示模式提示「演示模式下不会真的发送。」；空留言提交
    → 提示「请先写下要发送的内容。」；填好后提交 → 成功态「已经送到站长的信箱，谢谢。」
    且**留言仍在输入框里**（长度 20）。

### 4.3 过程中修的唯一一处（脚本侧，非产品代码）

第一版 P3 段有一条失败：`填写字段「锚点」失败：字段「锚点」找不到对应输入框（for=）`。
原因是属性面板里手写的两个字段（「后台显示名」「锚点」）走 `ui.tsx` 的 `Field`，label
没有 `htmlFor`、里面的 `<Input>` 也没有 `id`，所以既有 helper `fillFieldByLabel`（从
`for` 倒推输入框）在这里拿不到元素。**没有改产品代码**，只在 e2e 里加了
`fillInspectorFieldByLabel`：找到同名 label 后，取它最近 `.field` 容器里的第一个控件。
这条既是脚本限制，也是产品侧的既有可访问性缺陷（点 label 不聚焦、读屏不播报字段名），
已在 §15.7 第 6 条如实登记。

失败的三条断言与失败上下文（DOM 快照）都来自这次真实运行，没有伪造通过。

## 5. 文档

`docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` 追加
`## 15. P3 实现记录（2026-11-03）`，风格与 §13 / §14 一致（表格 + 加粗结论 + 已知取舍），
共 156 行、8 个小节：

- 15.1 服务端四个筛选参数（`category_id` / `tag` / `since` / `sort`）与「空串不当条件」；
- 15.2 三个区块的 props 与渲染规则（`content-query` / `anchor-nav` / `contact-form`）；
- 15.3 联系端点的状态码表、投递规则、边界单位（name/email 按字节、message 按字符）、
  以及「蜜罐 → 校验 → 冷却」的顺序；
- 15.4 本报告第 1–4 步的实测数字表 + e2e 新增段说明；
- 15.5 体积增量表（含上界说明）；
- 15.6 刻意的范围决定：**只做联系表单**，订阅名单与 A/B 未做及理由；规格 §7.1 的
  `popular` / `pinned` / `sort=popular` / `layout=mosaic` 也未进面板；
- 15.7 六条已知限制（见下）；
- 15.8 仍未做清单。

已知限制按任务要求逐条写清：

1. 冷却按实例计（进程内 map，多实例 = 每实例每分钟各放行一次，网关全局限流才是集群那层）；
2. 标签筛选是 JSON 文本的精确 token 匹配，因此标签名不能含 `"` 或 `\`（`NormalizeTag` 已挡成 400）；
3. 锚点去重作用域是一个 `ScreenRenderer`，文章页同时渲染两种版式时两棵树各算一趟，
   同名锚点会出现两个同 `id`；
4. 演示模式不筛选（不伪造）；
5. 邮箱只查形状，不验证可达性；
6. 属性面板手写字段的 label 没有 `htmlFor`（既有写法，P3 锚点控件沿用）。

## 6. 提交

```
294dba3 docs: record what P3 shipped
 2 files changed, 503 insertions(+), 1 deletion(-)
 apps/web/scripts/e2e-builder-blocks.mjs                          | +347 −1
 docs/superpowers/specs/2026-11-02-page-builder-v2-design.md      | +156
```

- 只 staging 了这两个精确路径；`git diff --cached --name-only` 核对过没有夹带。
- 设计文档是**纯追加**（`156 insertions(+)`，无删除、无其它会话的 hunk），无需拆段提交。
- e2e 脚本的 −1 是 `printSummary()` 里 `sections` 数组那一行（加入 `'P3'`）。

## 7. 未处理 / 留给下一步

- 没有修任何产品代码（包括 §15.7 第 6 条的可访问性问题），按要求只记录。
- 分布式冷却、订阅名单、A/B、`content-query` 的 popular/pinned/mosaic、锚点的页面级作用域
  均仍在 §15.8 的未做清单里。
- 体积数字是共用工作树的上界；要精确归因需在隔离 worktree 里对 P2 收尾提交重新构建。
