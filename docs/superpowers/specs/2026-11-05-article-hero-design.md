# 文章页封面式页头 + 媒体预览、发布模式与胶囊收缩

日期：2026-11-05
状态：已实现并验证
范围：`apps/web`（纯前端展示层，不改 OpenAPI 与 Go / Rust）

## 目标

四件来自用户反馈的事：

1. **文章页采用封面式展示**：封面图铺满整幅宽度，标题与摘要压在图上；
   正文区顶部再衬一层同图的高斯模糊，让封面自然「化」进正文。
2. **修复后台媒体资源预览照片不显示**：真实后端下，媒体库 / 媒体选择器 / 封面预览里的
   `content` 素材缩略图是裂图。
3. **发布模式三个选项排在一行**：站点设置与安装引导里，「开放发布 / 审核发布 / 按角色发布」
   原本竖排三行，改成同一行的三张卡。
4. **顶部悬浮胶囊的收缩动画**：滚动时从外侧向中心收窄，logo / 导航一起向中间靠。

## 一、文章页封面式页头

### 结构

公开文章 / 帖子详情页（`pages/site/ContentDetail.tsx`）：

```
<section class="article-hero">                  ← 仅当作者没有隐藏封面
  .article-hero-media                          ← 自定义封面 <img>，或程序化 Cover（data-plain）
  .article-hero-veil                           ← 底部加深的遮罩，保证白字可读
  .article-hero-inner.shell                    ← 与正文同宽（--article-width + 64px）的居中列
    .article-hero-top                          ← 返回列表胶囊 + 未发布状态
    .article-hero-text                         ← 眉题（文章 · 安全策略）/ h1 / 摘要
</section>
<div class="article-stage">                    ← 正文区，承载模糊底图
  .article-backdrop                            ← 同图 blur(52px) + 遮罩渐隐（仅有自定义封面时）
  .shell > article.article--hero
    .article-meta--hero                        ← 作者 / 日期 / 阅读时长 / 分享与编辑
    .article-taxonomy--hero                    ← 分类与标签
    .article-toc / .article-body / 底部操作条 / 作者卡 / 评论区 …
</div>
```

- 标题永远是白色 + 阴影：封面图与遮罩都是深色，不跟随主题令牌；夜航深色主题同样成立。
- 没有上传封面时，复用列表卡片的程序化封面（`Cover` 新增 `plain` prop，只画底纹不画大字），
  以 `<html data-plain="true">` 标记，CSS 隐藏 SVG 里的文字。
- 作者勾选「隐藏封面」时整块 hero 不渲染，退回原来的 `.article-head`（返回链接 / 标题 / 元信息照旧）。
- 顶部透明 / 悬浮页头时，封面向上伸到页头后面（`margin-top: calc(-1 * --pp-hero-header-h)`），
  详情页 mount 时给 `<html data-article-hero="on">`，让页头文字在滚动前变白、滚动后恢复主题色；
  离开页面即删除该标记。
- 窄屏：标题字号、hero 高度与底图高度分两档收紧；封面摘要最多三行。打印时隐藏封面与底图，标题回墨色。

### 文件

| 文件 | 作用 |
| --- | --- |
| `src/pages/site/ContentDetail.tsx` | 新的 hero / meta / stage 结构；`visibleCoverFor` 取封面；`data-article-hero` 标记 |
| `src/components/Cover.tsx` | `Cover` 新增 `plain`（只画底纹），`data-plain` 标记 |
| `src/styles/articleHero.css`（新） | `.article-hero-*` / `.article-backdrop` / `.article-meta--hero` 与响应式、打印规则 |
| `src/styles.css` | 新增一行 `@import './styles/articleHero.css';` |

## 二、后台媒体预览不显示

### 根因

- 媒体下载路由 `GET /api/v1/media/:assetID` 是 `optionalAuth`；匿名读取走
  `OpenAssetInSite → authorizeSharedAsset`（`apps/api/internal/media/service.go`）：
  `site` / `avatar` 直接放行，`content` 必须已被「已发布内容」或「已保存设计」引用，否则 404。
- 前端访问令牌只放在 `Authorization: Bearer`（`lib/api.ts` 的 `performRequest`），
  而 `<img src>` 不会带这个头。后台上传默认 `purpose=content`，因此缩略图请求被当成匿名请求 → 404。

### 修法

- `Backend.assetSrc(url)`（`lib/backend.tsx`）：
  - `HttpBackend`：对站内 `/api/v1/media/` 且同源的地址，用带 `Authorization` 的 `fetch`
    取字节，`URL.createObjectURL(blob)` 返回；`data:` / `blob:` / 外链原样返回；
    任何失败回退原地址，不抛异常（预览失败不应冒泡成页面错误）。
  - `DemoBackend`：原样返回（演示数据本来就是 data URL）。
- `lib/assetUrl.ts`（新）：`useMediaSrc(url) → { src, failed }`；站内媒体在 blob 到达前
  `src` 留空（避免多打一次必然 404 的匿名请求）；cleanup 只 revoke 自己造的 `blob:`，
  alive flag 丢弃过期结果。
- 接入位置：媒体库（失败回退现有图标）、页面编排与编辑器的媒体选择器、创作页封面预览。

## 三、发布模式一行显示

- `pages/admin/Settings.tsx` 与 `pages/Setup.tsx` 的发布模式容器从 `option-grid`
  改为 `option-grid three`（已有规则：三列等宽；≤820px 自动退回单列）。
- 未新增样式，不改变表单语义与保存逻辑。

## 四、顶部胶囊的收缩动画（同日追加）

用户要求：悬浮胶囊在滚动时「从外侧到里头收」，logo 等一起向中心缩。

- **顶部（未滚动）**：`.header-inner` 跟站点内容同宽（`max-width: var(--shell)`，
  沿用 `.shell` 的 32 / 22 / 16px 左右内边距），页头仍然透明。
- **滚动超过 `header_threshold` 后**（`.is-scrolled`）：
  - `max-width: min(calc(100% - 32px), 1180px)`、`padding-inline: 18px`；
  - `transform: scale(0.97)`（`transform-origin: 50% 0`），整条胶囊与 logo / 导航 / 操作区
    一起轻微向中心缩；
  - 宽度、内边距与缩放用 460ms `cubic-bezier(0.4, 0, 0.2, 1)`；底色、边框、阴影、模糊
    用 240ms 同步淡入；
  - 窄屏保留两侧 16px 空气，胶囊宽度收成 `100% - 32px`（390px 视口下 358px，实测无溢出）。
- `prefers-reduced-motion: reduce` 时直接落到胶囊状态，不做过渡。
- 只改 `src/styles/header.css`；`scripts/e2e-header.mjs` 新增 5 项断言并显式模拟
  `prefers-reduced-motion: no-preference`（无头 Chrome 默认匹配 reduce，会把过渡压成 0）。

## 五、编辑页右上角直接发布（同日追加）

用户反馈：写完文章要先存进草稿箱才能发布，希望在编辑页右上角直接点发布。

- 可编辑状态下，编辑页右上角固定两个按钮：
  - **保存草稿** → `save('draft')`：保存后仍是草稿；
  - **发布** → `save('published')`：先保存（新建则 `createDraft`），再走 `publish`；
    当前账户没有直接发布权限时，主按钮改为 **提交审核** → `save('pending_review')`（保存后 `submit`）。
- 两个按钮各自显示 loading（`saveBusy`），保存期间互斥禁用；校验、服务端清洗与 503 语义不变。
- 右侧「发布状态」面板由可点的三选一改为只读：当前状态 + 站点发布模式 + 权限说明，
  避免和右上角按钮形成两套入口。
- 文件：`pages/admin/Editor.tsx`、`lib/i18n/dict/fragments/pages_admin_Editor.ts`（3 条新文案）。
- 验证：`npx tsc --noEmit`、`npx vitest run`（75 文件 / 971 项）、`npx vite build` 通过；
  演示模式实测「新建 → 发布」后 URL 变为 `/admin/content/article/{id}`、状态「已发布」；
  「新建 → 保存草稿」后状态「草稿」。截图：`docs/assets/2026-11-05-editor-publish/`。

## 验证

```powershell
cd apps/web
npx tsc --noEmit
npx vitest run            # 75 文件 / 971 项，含新增 assetUrl 测试 10 项
npx vite build
node scripts/e2e-article-hero.mjs   # 新增，19 项
node scripts/e2e-header.mjs         # 29 项（含 5 项胶囊收缩断言）
PP_E2E_BASE=http://127.0.0.1:8099 node scripts/e2e-article-hero.mjs
```

- `e2e-article-hero.mjs` 覆盖：有封面 / 透明页头 / 隐藏封面 / 无自定义封面 / 夜航深色、
  发布模式三卡同一行、演示模式媒体缩略图；结果 PASS 19 / FAIL 0，控制台无错误。
- `e2e-header.mjs` 新增：顶部与收起后宽度差 >100px、收缩存在中间帧（1223px）、
  最终布局宽度 1180px、`transform: scale(0.97)`、logo 左移 33px → 150px；结果 PASS 29 / FAIL 0。
- 截图：`docs/assets/2026-11-05-article-hero/`（纸白图片封面、顶部透明页头、夜航程序化封面、
  发布模式一行、后台媒体库）；`docs/assets/2026-11-05-float-header/`（胶囊顶部 / 中间帧 /
  收起后 / 移动端）。
- 媒体预览的 live 链路由单元测试覆盖（Authorization 头、相对 api_base、外链不带令牌、
  404/断网回退、hook revoke）；真实后台上传 `content` 图片后缩略图应为 `blob:` 地址。
