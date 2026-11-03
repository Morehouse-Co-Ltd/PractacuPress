# 页面编排 v2 · P2 组件扩容 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0 的属性模型与 P1 的布局原语之上，补齐 13 个结构化组件，让站点能直接搭出落地页、团队页、产品页。

**Architecture:** 每个组件 = 注册表里一条 `BlockDefinition`（schema 驱动表单）+ 一个渲染器 + 一段 CSS。全部走既有链路：属性面板由 schema 自动生成，归一化按 schema 白名单清洗，主题令牌供色，`media` 属性接媒体库。**不新增任何运行时依赖**，交互一律用原生元素（`<details>` / `<dialog>` / `<audio>`）或几行 `useEffect`。

**Tech Stack:** React 19 + TypeScript 5.9 + Vitest 3；零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` §6

## Global Constraints

- 不新增任何 npm 运行时依赖。
- 新界面文案一律走 `t()` 并补英文；`src/lib/i18n/coverage.test.ts` 是硬闸门。
- 不允许出现 `any`；`npm run typecheck` 必须 0 错误。
- **每个组件的 `defaults` 键必须全部声明在它的 `schema` 里**——`repeaterProps.test.ts` 里有永久守卫，漏写就红。
- 所有颜色取自主题令牌（`var(--ink)` / `var(--line)` / `var(--bg-subtle)` / `var(--accent)` 等），深浅色都要能看。
- 可访问性：图片必须有 `alt`（`media` 属性旁配一个 `alt` 文本属性）；折叠用 `<details>`；灯箱用 `<dialog>` + 焦点返回；不自动播放音视频。
- 响应式只靠既有容器（`grid` / `section` / `columns`）与 CSS，不在组件里新造断点。
- **体积预算**：13 个组件合计 gzip 增量 ≤ 25 KB（P0 已用掉一部分 40 KB 预算）。
- 命令都在 `apps/web` 下执行；每个 Task 结束 `npx vitest run` 全绿 + 一次提交。
- 工作树与其它会话共享：`git add` 只加精确路径，禁止 `git add -A` / `git stash` / `git checkout -- .`。
- **不要用 PowerShell `Get-Content`/`Set-Content` 改写源码**（本仓库已被这个操作损坏过两次 UTF-8），用 read/edit/write。

---

### Task 1: `richtext` 属性类型

P2 里「图文交替」的正文需要段落级富文本；`text` 区块的 Markdown 渲染链路已经存在，这里只是把
它变成一种可复用的属性类型。

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（`PropType` 加 `'richtext'`）
- Modify: `apps/web/src/components/builder/BlockProps.tsx`（richext 控件）
- Modify: `apps/web/src/lib/customize.ts`（`richtext` 值按 Markdown 文本清洗：长度上限 8000，走既有 `scalarValue`）
- Test: `apps/web/src/lib/richtextProp.test.ts`（新建）

**Interfaces:**
- Produces: `PropType` 增加 `'richtext'`；值就是 Markdown 字符串。
- Produces: 表单控件 = 一个 `Textarea`（最小高 140px）+ 「预览」折叠区（用 `dangerouslySetInnerHTML` 渲染 `sanitizeHtml(renderMarkdown(value))`，与 `text` 区块同一套函数）。
- Consumes: `apps/web/src/lib/markdown.ts` 的 `renderMarkdown`、`apps/web/src/lib/markdown.ts` 或同目录的 `sanitizeHtml`（读代码确认真实导出名）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/richtextProp.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeBlockProps } from './customize';
import { BLOCK_DEFS } from './blocks';

describe('richtext 属性', () => {
  it('作为 Markdown 字符串保存，超长被截断', () => {
    const long = '# 标题\n\n' + '段落。'.repeat(3000);
    const props = normalizeBlockProps('media-text', { body: long });
    expect(typeof props.body).toBe('string');
    expect((props.body as string).length).toBeLessThanOrEqual(8000);
  });

  it('非字符串被丢弃', () => {
    expect(normalizeBlockProps('media-text', { body: 42 }).body).toBeUndefined();
  });

  it('至少有一个区块声明了 richtext 属性', () => {
    const types = BLOCK_DEFS.flatMap((def) => def.schema.map((field) => field.type));
    expect(types).toContain('richtext');
  });
});
```

（`media-text` 是 Task 4 才会加的区块；本任务先让 `text` 区块的 `body` 顺手升级成 `richtext`
以便测试有对象——若改动 `text` 会影响既有配置结构（它仍是 Markdown 字符串，所以不会），
就在报告里说明。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/richtextProp.test.ts
```

Expected: FAIL —— `PropType` 里没有 `richtext`，最后一个断言失败。

- [ ] **Step 3: 实现**

- `blocks.ts` 的 `PropType` 加 `| 'richtext'`，注释写明「Markdown 字符串，渲染前过 sanitizeHtml」。
- `BlockProps.tsx` 加 `richtext` 分支：`Textarea` + 可选预览。
- `customize.ts`：`richtext` 与 `textarea` 同路径清洗，但长度上限 8000（`scalarValue` 现在统一 4000，
  给 richtext 单独一条分支）。

- [ ] **Step 4: 验收并提交**

```bash
npx vitest run && npm run typecheck && npm run i18n:audit
git add apps/web/src/lib/blocks.ts apps/web/src/components/builder/BlockProps.tsx apps/web/src/lib/customize.ts apps/web/src/lib/richtextProp.test.ts
git commit -m "feat(web): add the richtext property type"
```

---

### Task 2: 无媒体组件三件套（功能网格 / 卡片组 / 步骤）

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（三条注册表定义）
- Create: `apps/web/src/components/blocks/MarketingBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`（注册渲染器）
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/marketingBlocks.test.ts`（新建）

**Interfaces:**
- Consumes: `PropSchema` 的 `repeater`、`blockPropRecord(block, key)`、`blockProp(block, key, fallback)`。
- Produces: `MARKETING_RENDERERS: Record<string, (props: { block }) => ReactElement | null>`，
  在 `components/blocks/index.tsx` 的 `RENDERERS` 里展开。

三条定义（`group: 'content'`，`variants: ['classic', 'bento']`）：

| type | 中文名 | defaults | schema 要点 |
| --- | --- | --- | --- |
| `feature-grid` | 功能网格 | `heading:'', columns:3, items:[]` | `heading` text；`columns` select 2/3/4；`items` repeater（`icon` text、`title` text、`text` textarea）最多 8 条 |
| `card-grid` | 卡片组 | `heading:'', columns:3, items:[]` | `heading` text；`columns` select 2/3/4；`items` repeater（`title` text、`text` textarea、`link` text）最多 9 条 |
| `steps` | 步骤 | `heading:'', orientation:'vertical', items:[]` | `heading` text；`orientation` select vertical/horizontal；`items` repeater（`title` text、`text` textarea）最多 8 条 |

**渲染要求**
- 空 `items` 时渲染一句引导文案（`t('在右侧添加条目。')`）而不是空白，让作者知道下一步做什么。
- 图标用内置图标集（`navigation.ts` 的 `NAV_ICON_CHOICES`），未知图标名静默不渲染。
- 横向步骤在窄屏自动退化为纵向（用 `@media (max-width: 767px)`，与 P1 断点表一致）。
- 卡片 hover 只做颜色变化，不做位移（`prefers-reduced-motion` 下自然无动画）。

**步骤**：先写 `marketingBlocks.test.ts`（断言三条定义存在、defaults 键 ⊆ schema、渲染器注册在生产
`RENDERERS` 里），再实现，再补 CSS，最后跑全量。

Commit: `git commit -m "feat(web): add the feature grid, card grid and steps blocks"`

---

### Task 3: 媒体组件三件套（团队 / Logo 墙 / 图集）

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/MediaGalleryBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/mediaGalleryBlocks.test.ts`（新建）

| type | 中文名 | defaults | schema 要点 |
| --- | --- | --- | --- |
| `team` | 团队成员 | `heading:'', columns:3, items:[]` | `items` repeater（`avatar` media、`name` text、`role` text、`link` text）最多 12 条 |
| `logo-wall` | Logo 墙 | `heading:'', columns:4, items:[]` | `items` repeater（`image` media、`link` text、`alt` text）最多 12 条 |
| `gallery` | 图集 | `heading:'', columns:3, ratio:'4:3', items:[]` | `ratio` select 1:1 / 4:3 / 16:9；`items` repeater（`image` media、`caption` text）最多 20 条 |

**渲染要求**
- `team`：头像圆形（`border-radius: 50%`），缺图时用姓名首字母做占位（主题色底），不出现破图图标。
- `logo-wall`：灰度显示、hover 恢复彩色；`filter: grayscale(1)`，`prefers-reduced-motion` 下不做过渡。
- `gallery`：栅格 + 原生 `<dialog>` 灯箱。点缩略图打开大图，`Esc` 关闭，关闭后焦点回到被点的缩略图
  （`dialog.close()` 后 `.focus()`）。灯箱里可以左右切换（上一张/下一张按钮 + 左右方向键）。
- 所有 `<img>` 必须有 `alt`（`logo-wall` 用条目里的 `alt`，缺省用 `#`? 不行——缺省空串 `alt=""` 表示装饰图）。

**测试**：三条定义存在且 defaults ⊆ schema；渲染器已注册；`gallery` 的灯箱状态机
（打开/关闭/前后切换的当前下标计算）抽成纯函数 `lightboxStep(current, delta, total)` 并单测。

Commit: `git commit -m "feat(web): add the team, logo wall and gallery blocks"`

---

### Task 4: 说服组件四件套（定价 / FAQ / 证言 / 图文交替）

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/ConversionBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/conversionBlocks.test.ts`（新建）

| type | 中文名 | defaults | schema 要点 |
| --- | --- | --- | --- |
| `pricing` | 定价表 | `heading:'', items:[]` | `items` repeater（`name`、`price`、`period`、`features` textarea（换行分隔）、`cta_label`、`cta_link`、`featured` toggle）最多 4 条 |
| `faq` | 常见问题 | `heading:'', open_first:false, items:[]` | `items` repeater（`question`、`answer` textarea）最多 20 条 |
| `testimonial` | 用户评价 | `heading:'', layout:'grid', items:[]` | `layout` select grid/carousel；`items` repeater（`quote` textarea、`name`、`role`、`avatar` media）最多 9 条 |
| `media-text` | 图文交替 | `image:'', alt:'', title:'', body:'', side:'left', cta_label:'', cta_link:''` | `image` media、`alt` text、`title` text、`body` richtext（Task 1）、`side` select left/right、`cta_*` |

**渲染要求**
- `pricing`：推荐档（`featured`）加主题色描边与「推荐」角标；`features` 按换行拆成列表项，
  以 `-` 开头视为"不含"（灰色删除线）。价格与周期做视觉主次。
- `faq`：原生 `<details>`，`open_first` 只影响第一条；问题用 `<summary>`（键盘可达）。
- `testimonial`：`carousel` 用 CSS `scroll-snap` 横滑（零 JS），加分页圆点（纯 CSS 做不到就省略圆点，
  在报告里说明）。
- `media-text`：`side` 控制图在左还是右，窄屏一律图在上、文在下；`body` 走 Markdown 渲染链路。
- 所有链接走既有 URL 白名单（`safeUrl`），外链补 `rel="noreferrer noopener"`。

**测试**：四条定义 defaults ⊆ schema；`features` 换行拆分的纯函数 `splitFeatures(text)` 单测
（含以 `-` 开头、空行、去重）；渲染器已注册。

Commit: `git commit -m "feat(web): add the pricing, FAQ, testimonial and media-text blocks"`

---

### Task 5: 剩余三个 + 收口（对比表 / 倒计时 / 音频）

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/components/blocks/UtilityBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/scripts/e2e-builder-blocks.mjs`
- Test: `apps/web/src/lib/utilityBlocks.test.ts`（新建）

| type | 中文名 | defaults | schema 要点 |
| --- | --- | --- | --- |
| `comparison` | 对比表 | `heading:'', left_label:'', right_label:'', rows:[]` | `rows` repeater（`label`、`left`、`right`）最多 12 条 |
| `countdown` | 倒计时 | `title:'', target:'', expired_text:'', show_seconds:true` | `target` 日期文本（`YYYY-MM-DD` 或 ISO）；`show_seconds` toggle |
| `audio` | 音频 | `src:'', title:'', artist:'', cover:''` | `src`/`cover` media、`title`/`artist` text |

**渲染要求**
- `comparison`：表格语义（`<table>` + `<th scope>`），窄屏可横向滚动，不塌成纯文本。
- `countdown`：`useEffect` 起 1s 定时器，卸载必须清理；倒计时结束显示 `expired_text`；
  服务端渲染无关（本项目纯客户端），但要避免首帧闪 `NaN`——初始状态显示占位。
- `audio`：原生 `<audio controls>`，`preload="metadata"`，**不自动播放**。

**收口**（本任务最后一步，必做）：
1. `npx vitest run` 全绿；
2. `npm run typecheck`、`npm run build` 通过，并记录 gzip 增量（对比 P1 收尾的构建产物，≤ 25 KB）；
3. `node scripts/e2e-builder-blocks.mjs` 跑通（PASS 数 ≥ 之前的 37），截图落 `.tmp/shots-builder/`；
4. 在 `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` 追加 §14「P2 实现记录」：
   组件清单、验证数字、体积增量、未做的（`anchor-nav` 顺延 P3）与已知取舍。

Commit: `git commit -m "feat(web): add the comparison, countdown and audio blocks"`

---

## Self-Review

**规格覆盖**

| 规格条目 | 任务 |
| --- | --- |
| §6 `richtext` 依赖 | Task 1 |
| §6 `feature-grid` / `card-grid` / `steps` | Task 2 |
| §6 `team` / `logo-wall` / `gallery` | Task 3 |
| §6 `pricing` / `faq` / `testimonial` / `media-text` | Task 4 |
| §6 `comparison` / `countdown` / `audio` | Task 5 |
| §6 `anchor-nav` | **顺延 P3**：它依赖 `anchor` 的编辑入口，而那是 P1 刻意留下的（见规格 §13） |

**刻意不做**：组件级懒加载（静态 import 更简单，体积预算已覆盖）；主题市场式的组件包；
`testimonial` 的自动轮播（会与"不自动播放"的原则冲突）。

**每个 Task 的验收口径一致**：定义存在 → defaults ⊆ schema → 渲染器已注册 → 纯函数有单测 →
全量绿 → 体积在预算内。
