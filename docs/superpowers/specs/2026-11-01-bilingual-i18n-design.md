# 站点中英双语（i18n）设计说明

日期：2026-11-01
状态：已确认，实施中
范围：`apps/web`（纯前端展示层，不改 OpenAPI、Go 与 Rust）

## 目标

站点可以在**简体中文 / English** 之间切换，切换入口只有两处：

1. 安装引导的第一步（欢迎页）；
2. 后台「站点设置 → 基本信息」。

语言是**站点级**设置：一个站点一种语言，全站（前台 + 后台 + 安装引导）一并对齐，
不提供访客级切换器。默认 `zh-CN`，老站点升级后观感与今天完全一致。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 语言作用域 | 纯站点级，一个站点一种语言 | 用户确认；实现最简，语义清晰 |
| 语言存哪 | `SiteCustomization.language` | 服务端 `site_customization.document` 是不透明 JSON，**零后端改动、零迁移**；且已有跨设备同步 |
| 文案键 | 中文原文作键（`t('站点设置')`） | zh 下 `t()` 原样返回，中文输出字节级不变，既有测试与视觉零回归；迁移是机械包裹，无需为 3000+ 条起名 |
| 后端错误文案 | 前端按 `problem.code` 映射英文 | Go 侧注释已写明 "Clients branch on Code, never on Message" |
| 内容 | 不翻译 | 文章、评论是作者的内容，不是界面文案 |

## 数据模型

`SiteCustomization` 新增一个可选字段：

```ts
/** 站点语言。旧站点缺省时按简体中文处理。 */
language?: Locale; // 'zh-CN' | 'en'
```

归一化在 `lib/customize.ts` 的 `readCustomization()`：未知值一律回退 `zh-CN`。

写入路径：

- **安装引导**：`Draft.language` 随草稿存 `pp.setup.draft.v1`，完成时由
  `setupCustomization()` 写入新建的站点设计；
- **站点设置**：`useCustomization().update({ language })`，即时生效并随既有防抖
  同步写回服务端（与主题、外观一致）；
- **演示模式**：只写 localStorage，行为一致。

## i18n 内核（`lib/i18n/`）

```
lib/i18n/
  index.ts        订阅、setLocale/getLocale、t()、useT()、useLocale()、errorText()
  locales.ts      语言清单与归一化
  format.ts       locale 感知的日期/相对时间/数字
  dict/index.ts   合并所有命名空间
  dict/<ns>.ts    每个命名空间一张英文表（并行迁移时一人一个文件，互不冲突）
  coverage.test.ts 覆盖率闸门
```

对外 API：

```ts
export type Locale = 'zh-CN' | 'en';

/** 中文原文作键；vars 支持 {name} 插值；英文条目可为单数/复数对。 */
export function t(text: string, vars?: Record<string, string | number>): string;

/** 组件内使用：订阅语言变化，切换后自动重渲染。 */
export function useT(): typeof t;
export function useLocale(): Locale;

/** 把 ApiError 翻译成当前语言的提示；优先按 problem.code 映射。 */
export function errorText(err: unknown): string;
```

规则：

- **组件里必须 `const t = useT()`**（不能直接 import `t`），否则切语言不重渲染；
  非组件模块（`format.ts`、`blocks.ts` 等）才用模块级 `t`。
- 复数：英文条目写成 `{ one: '1 article', other: '{count} articles' }`，按 `count` 选。
- 带标签的句子拆成多个 `t()`，不要整句塞 HTML。
- `useMemo`/`useCallback` 里含译文时，把 `locale` 放进依赖。

启动顺序（无闪烁）：`main.tsx` 在 `root.render()` 之前读 `loadConfig()`，
`setLocale(readCustomization(config).language)` 并写 `<html lang>`；`App.tsx` 里
`LocaleSync` 在 config 变化（含服务端水合）时再次同步。

## 界面接入

- **安装引导**：第 0 步「欢迎」右上角放语言切换（简体中文 / English 两个胶囊按钮），
  切换立即改变引导自身语言；`forceLive` 与草稿恢复都要保留选择。
- **站点设置**：`基本信息` 面板顶部新增「站点语言」单选卡（简体中文 / English），
  带一句说明「站点语言影响前台、后台与提示文案；已发布的内容不会被翻译。」
  即时生效，无需点保存。
- **SEO**：`og:locale`（`zh_CN` / `en_US`）与 JSON-LD `inLanguage` 跟随语言。
- **日期与数字**：中文仍 `2026.01.02`；英文 `Jan 2, 2026`；相对时间
  （刚刚 / 3 分钟前 → just now / 3 minutes ago）同样双语。

## 后端错误映射

`lib/api.ts` 的 `ApiError` 已带 `problem.code`。`errorText()` 在英文下按码映射：

`validation_failed`、`unauthenticated`、`permission_denied`、`not_found`、`conflict`、
`rate_limited`、`internal`、`invalid_cursor`、`idempotency_key_reuse`、`site_not_found`、
`site_domain_unverified`、`content_state_invalid`、`security_unavailable`、
`provider_not_configured`、`invalid_database_driver`、`email_not_configured`。

未识别的码回退服务端原文（中文），不会显示空错误。

## 质量闸门

- `scripts/i18n-audit.mjs`：扫描 `src/` 中未被 `t()` 包裹的中日韩字面量，输出分文件
  覆盖率与待迁移清单（排除注释、测试夹具、`lib/i18n/dict/`）。
- `src/lib/i18n/coverage.test.ts`：
  1. 源码里每个 `t('…')` 的字面量键都能在英文表里找到；
  2. 英文条目不含中日韩字符；
  3. `zh-CN` 下 `t()` 原样返回（保证中文零回归）。
- 每批迁移后必须：`npm run typecheck` 通过、`npx vitest run` 全绿。
- 术语表（统一用词）：站点 Site、内容 Content、文章 Article、帖子 Post、审核 Review、
  成员 Member、用户组 Group、页面 Page、页面编排 Page builder、主题 Theme、
  外观 Appearance、访问与域名 Access & domains、加载动画 Loading screen、
  存储策略 Storage、性能优化 Performance、人机验证 Human verification、
  安装引导 Setup。

## 分批

| 批次 | 范围 | 产出 |
| --- | --- | --- |
| P0 | 内核 + 数据模型 + 两个入口 + 后台外壳/导航 | 切语言后后台立即整体变英文 |
| P1 | 后台页面（25 个） | 后台全量英文 |
| P2 | 前台页面与区块（`pages/site`、`components/blocks`、站点外壳） | 前台全量英文 |
| P3 | `lib/` 标签表、demo 示例数据、API 错误码 | 收尾一致 |
| P4 | 双语截图验收 + README | 交付 |

## 明确不做

- 不翻译文章正文、评论、自定义页面内容等用户内容；
- 不改 Go 的错误 message，不改 OpenAPI 契约；
- 不做 URL / slug 的语言前缀（不做 `/en/...` 路由）；
- 不做访客级语言切换器；
- 不做第三种语言（结构留有余地，但本期只有中英）。
