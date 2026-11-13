# P2 Task 5 — 对比表 / 倒计时 / 音频 + P2 收口

- 分支：`feat/page-builder-v2-p0`
- 提交：`2f728e0 feat(web): add the comparison, countdown and audio blocks`
- 状态：**完成**（TDD 红→绿；全量 66 文件 / 829 用例绿；typecheck / build 通过；
  e2e PASS 49 / FAIL 0；设计文档已追加 §14）

## 1. 交付内容

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/blocks.ts` | 改（+71） | 三条定义：`comparison` / `countdown` / `audio` |
| `apps/web/src/components/blocks/UtilityBlocks.tsx` | 新建（273 行） | `UTILITY_RENDERERS` + 纯函数 `parseTargetDate` / `countdownParts` |
| `apps/web/src/components/blocks/index.tsx` | 改（+2） | `...UTILITY_RENDERERS` 展开进生产 `RENDERERS` |
| `apps/web/src/styles.css` | 改（+109 / 单 hunk） | 末尾追加「工具型区块」样式段 |
| `apps/web/src/lib/utilityBlocks.test.ts` | 新建（440 行，37 条用例） | 注册表 + 纯函数 + DOM + CSS |
| `apps/web/src/lib/i18n/dict/fragments/components_blocks_UtilityBlocks.ts` | 新建（+14） | 渲染器自己的 5 条词条 |
| `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts` | 改（+32） | 三条定义与字段的英译（26 条新词条） |
| `apps/web/scripts/e2e-builder-blocks.mjs` | 改（+322 / −2） | 新增 `UTILITY` 段落（12 条断言 + 3 张截图） |
| `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` | 改（+75） | 追加 §14「P2 实现记录」 |

沿用 P2 Task 2/3/4 的模块形状：数据侧只加定义，渲染侧只加一个 `*_RENDERERS` 映射文件，
CSS 追加一段，i18n 一个片段，一份注册表测试。没有一处需要改编辑器代码。

### 三条定义

- `comparison`：`heading` + `left_label` / `right_label` + `rows` repeater
  （`label` / `left` / `right`，最多 12 行）
- `countdown`：`title` + `target`（日期文本）+ `show_seconds` toggle + `expired_text`
- `audio`：`src` media / `title` / `artist` / `cover` media

三条都是 `group: 'content'`、`variants: ['classic', 'bento']`。

## 2. 渲染要点与取舍

- **对比表**：真 `<table>`——`thead` 三个 `<th scope="col">`、行首 `<th scope="row">`。
  左上角那格没有文案，用 `<span class="sr-only">项目</span>` 给读屏一个名字（空 `<th>`
  会念成"空白"）。两个表头都留空时**不画表头行**（一排空标题比没有更糟）。窄屏不折叠
  成卡片、也不塌成纯文本：`.pp-comparison-scroll` 横向滚动 + `table { min-width: 460px }`，
  容器 `role="region"` + `tabIndex={0}`，键盘可以用方向键横着看完。三列全空的行渲染时跳过。
- **倒计时**：`useEffect` 里 `setNow(Date.now())` 起第一帧、`setInterval(…, 1000)` 走秒，
  cleanup 里 `clearInterval`；依赖数组用**毫秒数字**而不是 `Date` 对象——`Date` 每次渲染
  都是新引用，会让 effect 自己触发自己。首帧状态是 `null`，画 `--` 占位，所以既不会闪
  `NaN`，也不会先显示满格再跳。结束时（或日期认不出来时）显示 `expired_text`，留空回退
  「已结束」。计时器 `role="timer"`（`aria-live` 默认关闭），否则读屏每秒念一遍。
  `show_seconds` 关掉时只画三格。
- **日期解析**（`parseTargetDate`，纯函数）：只认 `YYYY-MM-DD`（按**作者本地零点**，
  `new Date('2026-12-31')` 是 UTC 零点，东八区会提前 8 小时结束）与「日期 + 时间」的 ISO
  形式（`T` 或空格分隔，交给 `Date` 处理时区）。不存在的日期（`2026-02-31`）靠回读年月日
  识别——`new Date(y, m, d)` 会静默滚到下个月；`tomorrow` / `12/31/2026` / `2026-1-1` 这类
  各引擎解释不一的写法一律 `null`，不当成日期。
- **音频**：原生 `<audio controls preload="metadata">`，**不写 `autoPlay`**（e2e 里有一条
  专门的负向断言）。`src` / `cover` 先过 `safeUrl`；`src` 空或不过白名单时整块不画——
  `<audio>` 没 `src` 只会得到一个灰掉的空播放器。封面 `alt=""`（标题就在旁边，不重复念）。
- **空状态**：对比表没有可画的行时给作者「在右侧添加条目。」（复用既有词条）；
  倒计时三样全空、音频没有可播地址时返回 `null`（与 `text` / `media-text` 一致）。
- **上限二次截断**：旧配置可能超编，`rows` 渲染时按 12 再截一次。

## 3. 验证

- **基线（改动前实测）**：`npx vitest run` = **65 文件 / 792 用例** 全绿（与任务书一致）。
- **改动后**：`npx vitest run` = **66 文件 / 829 用例** 全绿（+1 文件 / +37 用例，与
  `utilityBlocks.test.ts` 的 37 条完全对应，没有别的用例被动增删）。
- **先红后绿的顺序**：先写 `utilityBlocks.test.ts`，跑出 `Failed to resolve import
  ".../UtilityBlocks"`（1 failed / no tests），再实现渲染器与定义。
- `npx tsc --noEmit`：exit 0。
- `npm run build`（`tsc --noEmit && vite build`）：成功，338 模块。
- `npm run i18n:audit`：覆盖率 96.3%（包裹 5044 / 待迁移 193）；`UtilityBlocks.tsx` 与
  `utilityBlocks.test.ts` **不在待迁移名单里**（0 条）；`lib/blocks.ts` 仍是改动前的
  36 条（全是既有演示文案）。
- `src/lib/i18n/coverage.test.ts`：3/3 通过（缺英文条目 = `[]`、英文无 CJK、占位符对齐）。

## 4. 体积增量（对比 P1 收尾产物，实测）

P1 收尾的构建产物还在 `apps/web/dist`（`assets` 时间戳 2026-11-03 11:02，逐字节加总
= **1,794,500 字节 raw**，与 `progress.md` 记录的基线一致）。先把它整体复制到
`apps/web/.tmp/dist-pre-p2/` 留档，再重建。

量法：`apps/web/.tmp/dist-size.mjs`——`dist` 下每个文件 `zlib.gzipSync(buf, { level: 9 })`
的长度求和（不是 vite 打印的估算值）。

| 口径 | P1 收尾 | P2 收尾 | 增量 |
| --- | --- | --- | --- |
| assets raw | 1,794,500 B | 1,841,330 B | **+46,830 B（+45.7 KiB）** |
| assets gzip | 544,062 B | 555,842 B | **+11,780 B（+11.5 KiB）** |
| CSS raw | 214,529 B | 227,999 B | +13,470 B |
| 主 JS raw | 1,270,692 B | 1,303,277 B | +32,585 B |
| 懒加载块 raw | ThemeBuilder 48,434 B | 49,209 B | +775 B |
| react / router | 221,715 / 39,130 B | 221,715 / 39,130 B | 0 |

**gzip 增量 +11.5 KiB，在 §7 的 25 KB 预算内**（规格原估「14 个组件 raw ≈ +50 KB、
gzip ≈ +15 KB」）。

**注意事项（如实记录）**：工作树是多会话共用的，这次重建包含别会话未提交的源码与样式
（`styles.css` 里 13 KB 的 CSS 增长大部分是它们的骨架屏 / 文章配图样式段），所以上表是
P2 增量的**上界**，不是「P2 恰好花了这么多」。我没有为了得到更小的数字去临时回退共享
文件——那会在别的会话正在编辑时改到它们的文件。

## 5. e2e

`node scripts/e2e-builder-blocks.mjs`（`PP_E2E_BASE=http://127.0.0.1:8099`，先
`npm run build` + `node scripts/serve.mjs --port 8099`）：

- **PASS 49 / FAIL 0**，退出码 0；此前基线是 PASS 37 / FAIL 0。
- 分段：SETUP 3/3、BUILDER 2/2、BUTTON 3/3、**UTILITY 12/12**、PALETTE 2/2、
  APPEARANCE 14/14、CONFIG 5/5、PERSIST 8/8。
- 新增的 12 条断言（`UTILITY`）：
  1–4. 追加「对比表」→ 填两个表头 + 一行 → iframe 里是真 `<table>`、`th[scope=col]` ×3
       且文案对位、`th[scope=row]` + 单元格按左右对位、`.pp-comparison-scroll` 存在且
       `tabindex=0`；
  5–7. 追加「倒计时」→ 填 `2099-12-31` → 四格数字（本次实测 `26720:10:53:11`）、
       文案无 `NaN`、`role="timer"`；
  8–10. 追加「音频」→ 填 `/media/e2e-audio.mp3` → 原生播放器 `controls` +
       `preload="metadata"`、**没有 `autoplay` 属性**（`autoplay=false`）；
  11–12. 三条组件库条目各自可点击追加。
- 截图 10 张在 `apps/web/.tmp/shots-builder/`（新增 `02b-comparison-block.png`、
  `02c-countdown-block.png`、`02d-audio-block.png`）。
- **第一次跑是 PASS 48 / FAIL 1**：`行头是 th scope=row，单元格按左 / 右对位` 失败，
  实测 `单元格=[1 人 | ]`。原因不是渲染 bug，而是我的轮询条件太松——`pollValue` 只等到
  「表格出现 + 有一行」就返回，此时右栏那一次 `change` 还没同步进预览 iframe（预览走
  storage 同步，有数帧延迟），断言拿的是中间态快照。把接受条件改成
  `cells.join(',') === '1 人,10 人'` 后复跑 **PASS 49 / FAIL 0**。这条如实记下来：
  第一轮的 e2e 是失败的，修的是测试的等待条件，不是产品代码。

## 6. 共享工作树与暂存方式

1. 只 `git add` 精确路径，从不用 `-A` / `stash` / `checkout -- .`；
2. 动手前先核对每个文件的 hunk 数：`blocks.ts` 1 hunk / +71、`blocks/index.tsx` 2 hunk
   / +2、`lib_blocks.ts` 1 hunk / +32、`e2e-builder-blocks.mjs`（改动前干净）；设计文档
   改动前完全干净，所以直接 `git add`；
3. `styles.css` 走「HEAD blob + 自己那一段」：`git cat-file blob HEAD:…styles.css` →
   用 `apps/web/.tmp/merge-styles.mjs` 在工作区文件里定位自己那段的注释头、剥出到 EOF、
   拼在 HEAD 版后面（中间补一个空行，与工作区排版一致）→
   `git hash-object -w --path=…` → `git update-index --cacheinfo`；
4. 核对：暂存区里 `styles.css` 只有 **1 个 hunk / +109**；随后未暂存的
   `git diff -- src/styles.css` 里已经搜不到 `pp-comparison`（只剩别会话的 416/23）；
5. 提交 `2f728e0`：9 个文件、**1338 insertions / 2 deletions**（2 行删除都是 e2e 脚本里
   我替换掉的旧文案与旧分段列表）。提交后工作区仍留着别的会话的改动，没被带走。

## 7. 未做的与已知取舍

- **`anchor-nav` 顺延 P3**：它依赖 `anchor` 的编辑入口，而那是 P1 刻意留下的（规格 §13）。
  规格 §6 的 14 个组件里少了这一个，已写进设计文档 §14.4。
- 倒计时按访客本地时区走秒（`Date.now()`），跨时区访客看到的是同一时刻的不同本地显示；
  这是"倒计时"的正确语义，没有做时区标注。
- 对比表在 460px 以下横向滚动而不是换行：两列对比的价值在对位，折叠会毁掉它。
- 音频没有做自建播放器（进度条 / 播放列表）：原生控件的键盘与读屏行为最稳，也不增加
  体积；要自定义皮肤是独立议题。
- 本任务没有 `useMemo` 缓存 `countdownParts`——它每秒只算一次、四个整数，缓存反而多一层。
