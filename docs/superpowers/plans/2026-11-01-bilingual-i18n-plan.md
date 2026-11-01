# 站点中英双语（i18n）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Practacu Press 前端支持站点级中英双语，语言在安装引导第一步与后台「站点设置」中选择，切一次全站生效。

**Architecture:** 新增 `lib/i18n/` 内核（中文原文作键的外部 store + `useT()` 订阅）。语言存在 `SiteCustomization.language`，随站点设计同步到服务端（不透明 JSON，零迁移）。各业务文件把中文字面量包裹成 `t('中文')`，英文表按命名空间拆成 `dict/<ns>.ts`，并行迁移时一人一文件，写入范围互不重叠。

**Tech Stack:** React 19 + TypeScript 5.9 + Vite 7 + Vitest 3；`useSyncExternalStore` 做语言订阅；`Intl` 做日期格式化。

## Global Constraints

- 默认语言 `zh-CN`；`zh-CN` 下 `t()` 必须原样返回键（含插值），保证中文零回归。
- 组件里只能用 `const t = useT()`，不得直接 import 模块级 `t`（否则切语言不重渲染）。
- 每个并行任务的英文表必须写进**自己独占**的 `dict/<ns>.ts`，禁止改别人的文件。
- 文案中文侧**一个字都不改**：包裹 `t()` 时保持原文、原文标点、原文空格。
- 英文条目禁止出现中日韩字符（`coverage.test.ts` 会拦）。
- 每批结束必须 `npm run typecheck` 与 `npx vitest run` 全绿。
- 术语：Site / Content / Article / Post / Review / Member / Group / Page / Page builder / Theme / Appearance / Access & domains / Loading screen / Storage / Performance / Human verification / Setup。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `apps/web/src/lib/i18n/index.ts` | store、`t`、`useT`、`useLocale`、`errorText`、`applyDocumentLocale` |
| `apps/web/src/lib/i18n/locales.ts` | `Locale` 类型、语言清单、`normalizeLocale` |
| `apps/web/src/lib/i18n/plural.ts` | 英文复数与 `{name}` 插值 |
| `apps/web/src/lib/i18n/labels.ts` | `labelMap`：常量查表变成「取值时翻译」 |
| `apps/web/src/lib/i18n/dict/index.ts` | `common` + `lib` + `import.meta.glob('./fragments/*.ts')` |
| `apps/web/src/lib/i18n/dict/common.ts` | 通用词（人工维护，不要让片段重复定义） |
| `apps/web/src/lib/i18n/dict/lib.ts` | 非页面模块标签表（角色、状态、相对时间） |
| `apps/web/src/lib/i18n/dict/fragments/<file>.ts` | **一个源文件一份**，命名 `pages_admin_Settings.ts` |
| `apps/web/src/lib/i18n/coverage.test.ts` | 覆盖率闸门（缺译 / 英文含中文 / 占位符不一致） |
| `apps/web/scripts/i18n-audit.mjs` | 未迁移文案扫描与覆盖率报告 |
| `apps/web/scripts/e2e-i18n.mjs` | 双语端到端验收（中英切换、刷新保持、零残留中文） |

### 并行迁移的配方（每个文件一次）

1. 读完整文件；
2. 把每一条用户可见中文包进 `t('原文')`，**中文一个字都不改**；
3. `.tsx` 里加 `const t = useT()`（绝不在组件里 import 裸 `t`），`.ts` 里 import `t`；
4. 句子里的变量改成 `{name}` 占位，英文复数写成 `{ one, other }`；
5. 注释、类名、id、URL、块类型、**会被持久化的默认值**不翻译；
6. 新建 `dict/fragments/<file>.ts` 放英文；已在 `common.ts` 的键不重复；
7. `npx tsc --noEmit` 只关心自己的文件。

**不做**：`lib/demoSeed.ts`、`lib/demo.ts`（演示站点的示例内容，是数据不是界面）。

---

### Task 0: i18n 内核

**Files:**
- Create: `apps/web/src/lib/i18n/locales.ts`
- Create: `apps/web/src/lib/i18n/plural.ts`
- Create: `apps/web/src/lib/i18n/index.ts`
- Create: `apps/web/src/lib/i18n/dict/index.ts`
- Create: `apps/web/src/lib/i18n/dict/common.ts`
- Test: `apps/web/src/lib/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `Locale`, `LOCALES`, `normalizeLocale(v): Locale`, `getLocale(): Locale`,
  `setLocale(next: Locale): void`, `subscribeLocale(fn): () => void`,
  `t(text: string, vars?: Record<string, string | number>): string`,
  `useT(): typeof t`, `useLocale(): Locale`, `errorText(err: unknown): string`,
  `applyDocumentLocale(): void`.

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { getLocale, setLocale, t } from './index';

describe('i18n', () => {
  it('zh-CN 原样返回中文键', () => {
    setLocale('zh-CN');
    expect(t('站点设置')).toBe('站点设置');
  });
  it('英文查表', () => {
    setLocale('en');
    expect(t('站点设置')).toBe('Site settings');
    setLocale('zh-CN');
  });
  it('插值在两种语言下都生效', () => {
    setLocale('zh-CN');
    expect(t('共 {n} 篇', { n: 3 })).toBe('共 3 篇');
    setLocale('en');
    expect(t('共 {n} 篇', { n: 3 })).toBe('3 articles');
    setLocale('zh-CN');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run src/lib/i18n/i18n.test.ts`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现内核**（`locales.ts` / `plural.ts` / `index.ts` / `dict/index.ts` / `dict/common.ts`）

关键实现约束：

```ts
// index.ts 核心
let current: Locale = 'zh-CN';
const listeners = new Set<() => void>();

export function t(text: string, vars?: Vars): string {
  if (current === 'zh-CN') return interpolate(text, vars);
  const entry = DICT[text];
  if (!entry) {
    if (import.meta.env.DEV) console.warn(`[i18n] 缺少英文条目：${text}`);
    return interpolate(text, vars); // 回退中文，绝不显示空串
  }
  const pattern = typeof entry === 'string' ? entry : pickPlural(entry, vars);
  return interpolate(pattern, vars);
}

export function useT() {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return t;
}
```

`interpolate` 用 `{name}` 占位替换；`applyDocumentLocale()` 写
`document.documentElement.lang`（`zh-CN` / `en`）。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/i18n
git commit -m "feat(web): add i18n core with chinese-as-key dictionaries"
```

---

### Task 1: 语言字段与两个入口

**Files:**
- Modify: `apps/web/src/types.ts`（`SiteCustomization.language?`）
- Modify: `apps/web/src/lib/customize.ts`（默认值 + 归一化 + `DEFAULT_CUSTOMIZATION`）
- Modify: `apps/web/src/main.tsx`（render 前 `setLocale`）
- Modify: `apps/web/src/App.tsx`（`LocaleSync`）
- Modify: `apps/web/src/pages/Setup.tsx`（第 0 步语言切换 + `Draft.language` + `setupCustomization`）
- Modify: `apps/web/src/pages/admin/Settings.tsx`（「站点语言」面板）
- Test: `apps/web/src/lib/customize.test.ts`（归一化断言）

**Interfaces:**
- Consumes: Task 0 的 `Locale`、`setLocale`、`useT`
- Produces: `SiteCustomization.language: Locale`（归一化后必有）；`<LocaleSync />`

- [ ] **Step 1: 写失败测试**

```ts
it('未知 language 回退 zh-CN', () => {
  const config = { customization: { ...DEFAULT_CUSTOMIZATION, language: 'fr' as never } };
  expect(readCustomization(config).language).toBe('zh-CN');
});
it('en 保留', () => {
  const config = { customization: { ...DEFAULT_CUSTOMIZATION, language: 'en' as const } };
  expect(readCustomization(config).language).toBe('en');
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现字段、归一化、启动同步、两个入口**
- [ ] **Step 4: 跑测试 + `npm run typecheck`**
- [ ] **Step 5: 提交**

---

### Task 2: 覆盖闸门与审计脚本

**Files:**
- Create: `apps/web/src/lib/i18n/coverage.test.ts`
- Create: `apps/web/scripts/i18n-audit.mjs`

- [ ] **Step 1: 写覆盖测试**（源码里每个 `t('…')` 键都在英文表里；英文表无中日韩字符；zh 恒等）
- [ ] **Step 2: 跑测试**（此时会因缺条目失败 —— 这是后续批次的验收依据）
- [ ] **Step 3: 写审计脚本**，输出分文件覆盖率
- [ ] **Step 4: 提交**

---

### Task 3: 后台外壳与导航

**Files:** `components/AdminShell.tsx`、`components/ui.tsx`、`components/Guards.tsx`、
`components/AdminGate.tsx`、`lib/toast.tsx`、`lib/hooks.ts`（`useTitle`）

**产出：** 侧边栏、分组、页头标题、通用按钮/弹窗/空态、提示条全部双语。
英文表写入 `dict/shell.ts`（独占）。

---

### Task 4: 站点设置与其子页

**Files:** `pages/admin/Settings.tsx`、`Access.tsx`、`AccessDomains.tsx`、`Domains.tsx`、
`Verification.tsx`、`Seo.tsx`、`Performance.tsx`、`Storage.tsx`、`Loading.tsx`

英文表写入 `dict/admin-site.ts`（独占）。

---

### Task 5: 安装引导

**Files:** `pages/Setup.tsx`（7 步全量）

英文表写入 `dict/setup.ts`（独占）。

---

### Task 6: 后台内容与社区页面

**Files:** `pages/admin/Dashboard.tsx`、`ContentList.tsx`、`Editor.tsx`、`Review.tsx`、
`Comments.tsx`、`Media.tsx`、`Taxonomy.tsx`、`Members.tsx`、`Permissions.tsx`、
`Activity.tsx`、`Docs.tsx`、`LoginSettings.tsx`、`components/MailSettings.tsx`、
`components/EditorToolbar.tsx`、`components/RichTextEditor.tsx`

英文表写入 `dict/admin-content.ts`（独占）。

---

### Task 7: 后台外观与主题

**Files:** `pages/admin/Themes.tsx`、`Appearance.tsx`、`PageEditor.tsx`、`Pages.tsx`、
`ThemeBuilder.tsx`、`Extensions.tsx`、`components/builder/*`、`components/theme/*`、
`lib/blocks.ts`、`lib/theme.ts`

英文表写入 `dict/admin-theme.ts`（独占）。

---

### Task 8: 前台外壳与页面

**Files:** `pages/site/*`、`pages/NotFound.tsx`、`components/SiteChrome.tsx`、
`components/SiteSearch.tsx`、`components/LoadingLayer.tsx`、`components/CommandLayer.tsx`、
`components/ErrorBoundary`、`lib/seo.ts`

英文表写入 `dict/site.ts`（独占）。

---

### Task 9: 前台区块组件

**Files:** `components/blocks/*`、`components/Cover.tsx`、`components/Filings.tsx`、
`components/DashboardInsights.tsx`

英文表写入 `dict/blocks.ts`（独占）。

---

### Task 10: lib 标签表、demo 数据、API 错误码

**Files:** `lib/format.ts`、`lib/permissions.ts`、`lib/site.ts`、`lib/demo.ts`、
`lib/demoSeed.ts`、`lib/logic.ts`、`lib/api.ts`、`lib/extensions.ts`

英文表写入 `dict/lib.ts`（独占）。

---

### Task 11: 验收

- [ ] `npm run typecheck`、`npx vitest run` 全绿
- [ ] `node scripts/i18n-audit.mjs` 覆盖率 100%（仅剩允许清单）
- [ ] `npm run build` 通过
- [ ] Playwright 双语截图：后台仪表盘/站点设置/安装引导，zh 与 en 各一张
- [ ] README「站点设置」段落补充语言说明

---

## 自检

**Spec 覆盖：** 数据模型（Task 1）、内核（Task 0）、两个入口（Task 1）、SEO/日期（Task 8/10）、
错误码（Task 10）、闸门（Task 2）、分期（Task 3–10）、验收（Task 11）——全覆盖。

**占位符：** 无 TBD；每个批次给了确切文件清单与英文表落点。

**类型一致性：** `Locale`、`t()`、`useT()`、`errorText()` 在 Task 0 定义，后续任务只消费不重定义。
