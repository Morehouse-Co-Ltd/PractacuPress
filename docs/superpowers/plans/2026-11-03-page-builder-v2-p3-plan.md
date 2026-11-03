# 页面编排 v2 · P3 数据与交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把静态版面变成能跑的落地页：统一的 `content-query` 查询块（服务端真筛选）、锚点目录、联系表单。

**Architecture:** 服务端给 `GET /articles` 与 `GET /posts` 增加四个筛选参数（`category_id` / `tag` / `since` / `sort`），前端新增 `content-query` 区块消费它们；锚点目录是纯前端（`anchor` + `IntersectionObserver` 高亮）；联系表单复用既有通知链路，不新建表。

**Tech Stack:** Go 1.x + Gin + Ent；React 19 + TS 5.9 + Vitest 3。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` §7

## Global Constraints

- **契约是硬闸门**：任何路由/参数变化都必须同步 `packages/contracts/openapi/openapi.yaml`，
  并让 `apps/api/internal/transport/http/gin` 的五个契约测试继续通过。
- 不新增任何 Go / npm 依赖。
- 前端：不允许 `any`；新文案走 `t()` + 英文；`src/lib/i18n/coverage.test.ts` 是硬闸门。
- **不做"前端假装筛选"**：服务端不支持的筛选条件，编辑器里禁用并说明，而不是在取回来的一页里过滤。
- 命令：Go 在仓库根、前端在 `apps/web`；每个 Task 结束两边测试全绿 + 一次提交。
- 工作树与其它会话共享：`git add` 只加精确路径；禁止 `git add -A` / `git stash` / `git checkout -- .`。
- **不要用 PowerShell `Get-Content`/`Set-Content` 改写源码**（已损坏过两次 UTF-8），用 read/edit/write。

---

### Task 1: 服务端列表筛选参数

**Files:**
- Modify: `apps/api/internal/content/service.go`（`ListFilter` 扩展）
- Modify: `apps/api/internal/infrastructure/contentstore/store.go`（`List` 查询）
- Modify: `apps/api/internal/content/handler.go`（`list` 解析 query）
- Modify: `packages/contracts/openapi/openapi.yaml`（`/articles` 与 `/posts` 的 parameters）
- Test: `apps/api/internal/content/listfilter_test.go`（新建）、`apps/api/internal/infrastructure/contentstore/store_list_test.go`（若已有同类测试则追加）

**Interfaces:**
- Produces: `ListFilter` 增加四个字段：

```go
type ListFilter struct {
	// …既有 SiteID / Kind / Statuses / AuthorID / After / Limit
	// CategoryID restricts the result to one category. Empty means any.
	CategoryID string
	// Tag restricts the result to items carrying this tag.
	Tag string
	// Since keeps items created at or after this instant. Zero means unbounded.
	Since time.Time
	// Sort picks the ordering: "newest" (default) or "oldest".
	Sort string
}
```

- Produces: `parseListFilter(c *gin.Context) (content.ListFilter, error)`（handler 内部，纯函数可测：把 query 解析成筛选条件，非法值返回 `ErrInvalidInput`）。
- Produces: `content.NormalizeTag(raw string) string`——标签名归一化（trim、长度 ≤ 40、拒绝含 `"` 与 `\` 的名字，返回空串表示非法）。

- [ ] **Step 1: 写失败测试**

新建 `apps/api/internal/content/listfilter_test.go`：

```go
package content

import (
	"testing"
	"time"
)

func TestNormalizeTag(t *testing.T) {
	cases := map[string]string{
		"  Go  ":   "Go",
		"a":        "a",
		`bad"tag`:  "",
		`bad\tag`:  "",
		"":         "",
	}
	for in, want := range cases {
		if got := NormalizeTag(in); got != want {
			t.Fatalf("NormalizeTag(%q) = %q, want %q", in, got, want)
		}
	}
	long := make([]byte, 60)
	for i := range long {
		long[i] = 'a'
	}
	if got := NormalizeTag(string(long)); len(got) > 40 {
		t.Fatalf("NormalizeTag kept %d bytes, want <= 40", len(got))
	}
}

func TestListFilterSortValidation(t *testing.T) {
	if _, err := ValidateSort("newest"); err != nil {
		t.Fatalf("newest must be valid: %v", err)
	}
	if _, err := ValidateSort(""); err != nil {
		t.Fatalf("empty must default, not fail: %v", err)
	}
	if _, err := ValidateSort("popular"); err == nil {
		t.Fatal("unsupported sort must be rejected")
	}
	_ = time.Now()
}
```

（`ValidateSort` 与 `NormalizeTag` 都放 `content` 包，前者返回归一化后的排序名。）

- [ ] **Step 2: 跑测试确认失败**

```bash
go test ./apps/api/internal/content/ -run 'TestNormalizeTag|TestListFilterSortValidation' -v
```

Expected: FAIL —— `undefined: NormalizeTag` / `ValidateSort`。

- [ ] **Step 3: 实现**

- `content/service.go`：加 `NormalizeTag`、`ValidateSort`、`ListFilter` 的四个新字段；`List` 与
  `ListAfter` 把它们透传给仓储。
- `contentstore/store.go` 的 `List`：`CategoryID` 非空 → `contentitem.CategoryIDEQ(...)`；
  `Tag` 非空 → `contentitem.TagsContains("\"" + tag + "\"")`（库里是 JSON 数组文本，用带引号的精确
  token 匹配；`NormalizeTag` 已禁掉引号与反斜杠，不会误配）；`Since` 非零 →
  `contentitem.CreatedAtGTE(since)`；`Sort == "oldest"` → 改成 `Asc`，否则保持 `Desc`。
  在注释里写明：`tags` 是 JSON 文本，精确 token 匹配是为了跨 SQLite / MySQL / PostgreSQL 可移植。
- `handler.go` 的 `list`：解析 `category_id`（≤36 字符）、`tag`（走 `NormalizeTag`，非法直接 400）、
  `since`（RFC3339，非法 400）、`sort`（`ValidateSort`，非法 400），塞进 `ListFilter`。

- [ ] **Step 4: 契约同步**

`packages/contracts/openapi/openapi.yaml` 的 `/articles` 与 `/posts`（两个 `get`）各加四个 query
参数，写法与既有 `Limit` / `Cursor` / `AuthorID` 一致：

```yaml
        - name: category_id
          in: query
          required: false
          description: Narrow the page to one category.
          schema: { type: string, maxLength: 36 }
        - name: tag
          in: query
          required: false
          description: Narrow the page to items carrying this tag (exact match).
          schema: { type: string, maxLength: 40 }
        - name: since
          in: query
          required: false
          description: Only items created at or after this instant (RFC 3339).
          schema: { type: string, format: date-time }
        - name: sort
          in: query
          required: false
          description: Ordering. `newest` (default) or `oldest`.
          schema: { type: string, enum: [newest, oldest] }
```

- [ ] **Step 5: 验收并提交**

```bash
go build ./apps/api/... && go test ./apps/api/internal/content/ ./apps/api/internal/infrastructure/contentstore/ \
  ./apps/api/internal/transport/http/gin/ 2>&1 | tail -20
git add <exact paths>
git commit -m "feat(api): filter the content list by category, tag, since and sort"
```

---

### Task 2: `content-query` 查询块

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（注册 `content-query`）
- Create: `apps/web/src/components/blocks/QueryBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/lib/api.ts`（`listContent` 透传新参数）
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/queryBlock.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的四个参数；`FeedContext`、`useTaxonomy`、`blockPropRecord`。
- Produces: `queryRequest(block): { categoryId?, tag?, since?, sort, limit, layout }`——纯函数，
  把区块 props 翻译成请求参数；空值不出现（而不是传空串）。
- Produces: `sinceFromWindow(window: string, now: Date): string | undefined`——`7d`/`30d`/`all`
  → RFC3339；`all` 返回 `undefined`。

| props | 类型 | 说明 |
| --- | --- | --- |
| `source` | select `latest` / `category` / `tag` / `author` | 选后两个时才启用对应筛选 |
| `term_id` | text | 分类或标签的 id/名称 |
| `window` | select `all` / `7d` / `30d` | |
| `sort` | select `newest` / `oldest` | |
| `layout` | select `list` / `grid` | 复用既有卡片样式 |
| `limit` | number 1–24 | |
| `show_excerpt` / `show_meta` | toggle | |

**渲染要求**
- 取数走 `api.listContent`（真实后端）与演示数据（demo 模式）两条既有路径；
  演示模式没有服务端筛选，**编辑器里把 `source`/`window`/`sort` 之外的条件标注为"演示模式不生效"**。
- 空结果渲染一句 `t('这里还没有内容。')`，不渲染空容器。
- 骨架：在 `lib/loading.ts` 的 `BLOCK_SKELETON_SHAPES` 里给它登记一个形状（它依赖 feed 数据）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/queryBlock.test.ts
import { describe, expect, it } from 'vitest';
import { queryRequest, sinceFromWindow } from './blocks';

describe('sinceFromWindow', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  it('all 不带时间条件', () => {
    expect(sinceFromWindow('all', now)).toBeUndefined();
  });
  it('7d / 30d 换算成 RFC3339', () => {
    expect(sinceFromWindow('7d', now)).toBe('2026-10-27T00:00:00.000Z');
    expect(sinceFromWindow('30d', now)).toBe('2026-10-04T00:00:00.000Z');
  });
  it('坏值回落到不带条件', () => {
    expect(sinceFromWindow('nope', now)).toBeUndefined();
  });
});

describe('queryRequest', () => {
  it('latest 不带分类与标签', () => {
    const req = queryRequest({ source: 'latest', limit: 6, sort: 'newest' } as never);
    expect(req.categoryId).toBeUndefined();
    expect(req.tag).toBeUndefined();
    expect(req.limit).toBe(6);
  });
  it('category 源带上 term_id', () => {
    const req = queryRequest({ source: 'category', term_id: 'cat-1', limit: 3 } as never);
    expect(req.categoryId).toBe('cat-1');
  });
  it('空 term_id 不产生空串条件', () => {
    const req = queryRequest({ source: 'category', term_id: '', limit: 3 } as never);
    expect(req.categoryId).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run src/lib/queryBlock.test.ts`

- [ ] **Step 3: 实现**（注册表条目 + 两个纯函数 + 渲染器 + 样式 + 骨架登记）

- [ ] **Step 4: 验收并提交**

```bash
npx vitest run && npm run typecheck && npm run build
git commit -m "feat(web): add the content query block"
```

---

### Task 3: 锚点与目录

**Files:**
- Modify: `apps/web/src/components/builder/BlockInspector.tsx`（锚点输入）
- Modify: `apps/web/src/lib/blocks.ts`（注册 `anchor-nav`）
- Create: `apps/web/src/components/blocks/AnchorNav.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`、`apps/web/src/styles.css`
- Test: `apps/web/src/lib/anchorNav.test.ts`（新建）

**Interfaces:**
- Consumes: `BlockInstance.anchor`（P0 建模、P1 保留）。
- Produces: `normalizeAnchor(raw: string): string`——小写、空格转 `-`、只留 `[a-z0-9-]`、≤ 40 字符。
- Produces: `anchorTargets(blocks: BlockInstance[]): { anchor: string; title: string }[]`——递归收集同页有锚点的区块（保持文档顺序），供目录渲染与测试共用。

**渲染要求**
- 目录渲染成 `<nav aria-label="本页目录">` + 一组 `<a href="#anchor">`。
- 滚动高亮用 `IntersectionObserver`（阈值 0.25），卸载时 `disconnect()`；
  没有 `IntersectionObserver` 的环境退化为不高亮（不影响跳转）。
- 锚点为空或重复时：区块侧忽略，目录侧去重（第一次出现者胜）。
- 点击是原生锚点跳转，不调 `scrollIntoView`——保持可复制 URL、可用浏览器前进后退。
- 平滑滚动交给 CSS：`html { scroll-behavior: smooth }`，并在 `prefers-reduced-motion` 下关掉
  （检查 `styles.css` 是否已有这条，有就复用，别写第二份）。

- [ ] **Step 1–4**：先写 `anchorNav.test.ts`（`normalizeAnchor` 的归一化与截断、`anchorTargets` 的
  递归收集与去重），再实现，再跑全量。
  `BlockInspector` 里加一个「锚点」文本输入，写入走既有的 `patch`（锚点不属于展示层，不进 `at`）。

Commit: `git commit -m "feat(web): add block anchors and the table of contents block"`

---

### Task 4: 联系表单

**范围决定（写进报告）**：只做**联系表单**，复用既有通知链路——提交即给站点管理员发一条通知，
不新建表、不做订阅名单。理由：订阅名单需要订阅者表、退订、导出与合规声明，是独立议题；
而"读者能给站长留一句话"用通知就能闭环，且没有任何数据留存风险。

**Files:**
- Modify: `apps/api/internal/notifications/*`（新增一个内部投递入口，或复用既有创建通知的服务）
- Create: `apps/api/internal/site/contact.go` + `contact_test.go`
- Modify: `apps/api/internal/site/handler.go`（挂 `POST /sites/{siteID}/contact`）
- Modify: `packages/contracts/openapi/openapi.yaml`
- Modify: `apps/web/src/lib/blocks.ts`（注册 `contact-form`）
- Create: `apps/web/src/components/blocks/FormBlocks.tsx`
- Test: `apps/web/src/lib/contactForm.test.ts`（新建）

**接口**
- `POST /sites/{siteID}/contact`，匿名字段：`name`（≤80）、`email`（≤200，必须含 `@`）、
  `message`（≤2000）。成功 202，失败 400。
- **反滥用**：走引擎既有的全局限流；再加一个 honeypot 字段 `website`（非空即静默返回 202 但不投递）
  与提交间隔限制（同一会话 60 秒一次，前端与服务端各一层）。
- 通知正文只存纯文本，主题形如 `站点来信：<name>`；不把用户输入拼进 HTML。

**前端**
- `contact-form` 区块：`heading` / `intro`（richtext）/ `submit_label` / `success_text` /
  `show_email` / `show_name`（toggle）。
- 提交态三态：idle / sending / sent，失败显示 `t('发送失败，请稍后再试。')`，永远不清空用户输入。
- 演示模式：不发请求，直接进入成功态，并在按钮下方标注 `t('演示模式下不会真的发送。')`。

**测试**
- Go：`contact_test.go` 覆盖合法提交 → 202 且投递一次；`message` 超长 → 400；honeypot 非空 →
  202 且不投递；60 秒内二次提交 → 429。
- 前端：`contactForm.test.ts` 覆盖字段校验（空消息、非法 email）与 honeypot 触发时不调用 API。

Commit: `git commit -m "feat: add the contact form block and its endpoint"`

---

### Task 5: 收口

- 全量验证：`go build ./apps/api/... && go test ./apps/api/...`；`npx vitest run`、`typecheck`、`build`。
- 体积：与 P2 收尾的构建产物比对，gzip 增量 ≤ 10 KB。
- e2e：`node scripts/e2e-builder-blocks.mjs` 增加一段（加一个 `content-query`、一个 `anchor-nav`、
  一个 `contact-form`，断言渲染与截图），PASS 数不得低于之前的 49。
- 设计文档追加 §15「P3 实现记录」：参数清单、验证数字、体积增量、未做的（订阅名单、A/B）。

Commit: `git commit -m "docs: record what P3 shipped"`

---

## Self-Review

| 规格条目 | 任务 |
| --- | --- |
| §7.1 统一查询块（服务端真筛选） | Task 1 + Task 2 |
| §7.2 锚点与动作复用 | Task 3 |
| §7.3 表单 | Task 4（只做联系表单，订阅明确延期） |
| §3.2 内容列表参数缺口 | Task 1 直接补上 |

**风险最高的两处**：Task 1 的 tag 匹配（JSON 文本精确 token，跨库可移植但依赖标签名不含引号，
已在 `NormalizeTag` 里挡住）；Task 4 的反滥用（限流是进程内的，多实例部署需要网关配合，
报告里要写明）。
