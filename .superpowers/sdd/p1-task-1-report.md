# Task 1 报告：断点、间距标尺与 `at` 求值

- **状态**：完成
- **分支**：`feat/page-builder-v2-p0`
- **提交**：`d48ff02` — `feat(web): evaluate per-device overrides and unify the breakpoint table`
- **测试**：`npx vitest run` → **53 文件 / 582 用例全部通过**（基线 52 / 571）；`npm run typecheck` → 0 错误。

## 需求来源

`.superpowers/sdd/p1-task-1-brief.md` 的中文正文是乱码（UTF-8 被按 GBK 解码），
代码块本身可读、与计划文件一致。为避免误读要求，正文按
`docs/superpowers/plans/2026-11-03-page-builder-v2-p1-plan.md` 的 `### Task 1` 逐条核对执行
（两个版本的代码块内容完全相同）。建议后续重新生成该 brief 的编码。

## 执行过程（按 brief 的步骤）

1. **Step 1 — 写失败测试**：新建 `apps/web/src/lib/layout.test.ts`，逐字采用 brief 的用例
   （断点、`spacingPx`、`overlayAt` 四条、`applyDisplayOverrides` 两条），共 10 个用例。
2. **Step 2 — 确认红**：`npx vitest run src/lib/layout.test.ts` → `Cannot find module './layout'`（1 failed，no tests）。
3. **Step 3 — 写 `apps/web/src/lib/layout.ts`**：逐字采用 brief 的实现
   （`BREAKPOINT_SM/MD/LG`、`SPACING_SCALE`、`spacingPx`、`overrideOf`、`overlayAt`、`applyDisplayOverrides`）。
4. **Step 4 — 类型放开**：`apps/web/src/types.ts` 的 `BlockInstance` 在 `offset?: BlockSpan;`
   之后追加 `align`、`gap_scale`、`mt`、`mb`（`overlayAt` 的赋值需要这些顶层字段；
   `BlockDisplayOverride` 早已声明它们，此前只是没有落点）。未使用 `any`。
5. **Step 5 — 确认绿**：`layout.test.ts` 10/10 通过，`npm run typecheck` 0 错误。
6. **Step 6 — 收敛断点**：
   - `apps/web/src/lib/blocks.ts`：`builderDeviceForWidth` 改为
     `width < BREAKPOINT_MD → mobile`、`width < BREAKPOINT_LG → tablet`，阈值从 `./layout` 引入；
     旧注释（`≤640 / 641–1023`）改为"阈值来自 lib/layout.ts 的唯一断点表"。
   - `apps/web/src/lib/logic.ts`：`is_mobile` / `is_desktop` 的提示文案改由 `BREAKPOINT_MD` 拼出
     （`MOBILE_HINT` / `DESKTOP_HINT`），并在注释里写明"与编排器共用同一张断点表"。
     **注意**：`logic.ts` 里从来没有比较宽度的代码，真正判定 `isMobile` 的 768 在
     `components/LogicRuntime.tsx`（两处 `window.innerWidth < 768`），见下节。
7. **Step 7 — 渲染入口求值**：`apps/web/src/components/blocks/index.tsx` 的 `ScreenRenderer`
   改为 `applyDisplayOverrides(screenBlocksForDevice(layout, device), device).filter(...)`，
   `applyDisplayOverrides` 从 `../../lib/layout` 引入。
8. **Step 8 — 全量验证并提交**：`npx vitest run` + `npm run typecheck` 全绿后，
   仅暂存 8 个精确路径提交（索引此前为空，未触碰他人的未提交改动，未用 `git add -A`）。

## 超出 brief 的文件（均在报告里说明原因）

1. **`apps/web/src/components/LogicRuntime.tsx`**（+3/−2）
   brief 说"`logic.ts` 里 `is_mobile`/`is_desktop` 的 768 改用 `BREAKPOINT_MD`"，但 768 的真实
   判定在 `LogicRuntime.tsx` 里（`logic.ts` 只是纯函数，读 `ctx.isMobile`）。若只改文案而放过
   这两处，任务目标"同一台设备在编排器与逻辑链里身份相同"不会达成。因此两处
   `window.innerWidth < 768` → `< BREAKPOINT_MD`。**行为不变**（`BREAKPOINT_MD === 768`），
   只是把阈值变成单点定义。
2. **`apps/web/src/lib/screenLayout.test.ts`**（+6）— 为**有意的阈值变化**补回归护栏：
   新增 `it('编排器与思维链共用同一张断点表（手机阈值 768）')`，断言
   `builderDeviceForWidth(700) === 'mobile'`、`builderDeviceForWidth(768) === 'tablet'`。
   原有用例（1440 / 900 / 390）无需修改，也没有任何现存测试写死 640。

## 行为变化（有意）

`builderDeviceForWidth` 的手机阈值 640 → 768：

| 宽度 | 之前 | 现在 |
| --- | --- | --- |
| 641–767 | tablet | **mobile** |
| 768 | tablet | tablet |
| ≥1024 | desktop | desktop |

这会影响 `ScreenRenderer` 的档位选择：641–767px 的面板现在取手机版编排 / 手机覆盖层。
除此之外，`at` 在此之前完全没人读，因此 v1 配置里没有 `at` 时渲染结果仍与 P0 一致
（`applyDisplayOverrides` 在 `desktop` 上原样返回入参）。

## 验证记录

```
npx vitest run          → Test Files 53 passed (53), Tests 582 passed (582)
npm run typecheck       → tsc --noEmit，0 错误
npx vitest run src/lib/layout.test.ts → 10 passed (10)
```

## 交接给后续 Task 的接口

- `lib/layout.ts` 导出的 `BREAKPOINT_SM/MD/LG`、`SPACING_SCALE`、`spacingPx()`、
  `overlayAt()`、`applyDisplayOverrides()` 已可直接被 `grid` / `section` 布局原语与
  `lib/visibility.ts` 复用。
- `ScreenRenderer` 现在是唯一的覆盖求值点；子树拿到的区块已按设备合并完毕，无需再判断设备。
- `BlockInstance` 已具备 `align` / `gap_scale` / `mt` / `mb`，布局渲染器可以开始消费它们。

## 事故与修复（记录在案）

中途用 PowerShell `Get-Content | Set-Content` 做 `768 → BREAKPOINT_MD` 批量替换，导致
`LogicRuntime.tsx` 被按错误编码重写（中文注释损坏、换行丢失）。已 `git checkout --` 该单文件
复活（确认此前无他人未提交 hunk），改用逐处编辑重做，最终 diff 为 +3/−2 的最小形态
（已在提交前用 `git diff` 复核）。教训：本仓库 UTF-8 中文文件一律用编辑工具而非 shell 管道改写。
