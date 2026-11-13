# P1 Task 7 报告：编辑器的继承 / 覆盖

分支：`feat/page-builder-v2-p0`　提交：见下方「提交」小节　工作目录：`apps/web`

## 1. 交付内容

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/lib/layout.ts` | 新增 `writeOverride(block, device, patch)`、内部 `mergeOverride`；导出原有的 `overrideOf` |
| `apps/web/src/lib/layout.test.ts` | 新增 `describe('writeOverride')` 共 6 条用例 |
| `apps/web/src/components/builder/BlockInspector.tsx` | 接收 `device`，展示层写入改走 `writeOverride`；非桌面显示「已覆盖」与「恢复继承」 |
| `apps/web/src/pages/admin/ThemeBuilder.tsx` | 把 `device` 传给检查器；`changeDevice` 不再无差别重置撤销栈 |
| `apps/web/src/lib/i18n/dict/fragments/components_builder_BlockInspector.ts` | 4 条新文案的英文条目 |

## 2. TDD 过程

1. **红**：先只加测试（`writeOverride` 尚未实现）。`npx vitest run src/lib/layout.test.ts` → `Tests 6 failed | 15 passed (21)`，失败原因 `TypeError: writeOverride is not a function`。
2. **绿**：实现 `writeOverride` 后 `src/lib/layout.test.ts` → `21 passed`。
3. **接线**：改 `BlockInspector` / `ThemeBuilder`，再跑全量 + typecheck。

## 3. `writeOverride` 的语义

```ts
writeOverride(block: BlockInstance, device: BuilderDevice, patch: BlockDisplayOverride): BlockInstance
```

- `desktop`：`{ ...block, ...patch }`，直接并回基础字段——与改造前 `patch({ appearance })` 的写入完全一致，所以常见路径的 WYSIWYG 不变。
- `tablet` / `mobile`：patch 并进 `at[device]`，基础字段一动不动。
- 合并是键级替换；`appearance` 是唯一下沉一层的字段（外观本来就按字段继承，整块替换会把没动过的字段一起冻住）。
- 显式 `undefined` = 「这一项恢复继承」：删掉该键（`appearance` 里同样逐键删除）。
- 空 patch = 「恢复继承整层」：删掉 `at[device]`；覆盖层空了就连 `at` 一起删，配置里不留空对象。
- 永远是纯函数：入参区块不被修改。

## 4. 测试覆盖

brief 的三条用例逐字照搬（唯一改动见下），另加三条：

1. 手机上改外观写进 `at.mobile`，不动基础外观（brief）
2. 桌面上改外观写回基础字段（brief）
3. 恢复继承：传空 patch 时删掉该设备的覆盖（brief）
4. **写覆盖不修改入参，也不把覆盖泄漏进基础字段**（brief 要求的第 4 条：证明设备覆盖不动基础块）
5. 外观按字段合并，显式 undefined 恢复单项继承
6. 覆盖层清空后 `at` 整键消失，不留下空对象

**与 brief 的唯一偏差**：第 2 条原句 `expect(next.at?.desktop).toBeUndefined()` 无法通过 `tsc`
——`BlockInstance['at']` 的类型只有 `tablet` / `mobile`，`desktop` 根本不存在（这正是「桌面没有覆盖层」
的类型级保证）。断言保留、改为绕类型读取：

```ts
expect((next.at as Record<string, unknown> | undefined)?.desktop).toBeUndefined();
```

## 5. 编辑器接线

- `BlockInspector` 新增必填 prop `device`；表单显示的是 `overlayAt(block, device)`（「这一层生效后的样子」），
  写入仍基于基础区块，所以读到的观感和写下去的位置不会互相污染。
- 展示层字段（`animation` / `width` / `height` / `custom_css` / `hidden` / 六项外观）统一走
  `writeDisplay()`：桌面同旧行为，非桌面落进 `at[device]`；非桌面会先把「本来就等于基础值」的编辑抹成
  `undefined`——覆盖层只记真正的差异，把值点回基础值就等于恢复继承。
- 非桌面时面板顶部出现设备徽标 +「恢复继承」（`writeDisplay({})`，无覆盖时禁用），被覆盖的每一项旁边有
  「已覆盖」徽标（`Field` 的 `aside` 槽；`hidden` / `主题描边` 两个 `Toggle` 没有 aside 槽，改用 description 提示）。
- 内容不受影响：`title` / `props` / `column` / `area` 仍写基础字段，`props` 永远进不了覆盖层。
- `ThemeBuilder.changeDevice`：撤销栈与选中项保留。**保留分支**：`screenLayout.device_split` 为真时各设备
  仍是独立的树（`persistBlocks` 会写 `devices[device]`），此时不换栈会把上一台设备的编排写到这台设备名下，
  所以那一种情况继续 `history.reset()`。`switchTarget`（切换页面 / 目标）的重置原样保留。

## 6. 验证

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | 58 files / 648 tests 通过（基线 58 / 637；+6 为本任务新增，其余为工作树中并行任务的用例） |
| `npm run typecheck` | 通过（无输出） |
| `npm run i18n:audit` | 覆盖率 96.2%（与基线同），`BlockInspector.tsx` / `ThemeBuilder.tsx` / `layout.ts` 待迁移均为 **0** |
| `src/lib/i18n/coverage.test.ts` | 3 tests 通过（新键均有英文，占位符形状一致） |

新增文案（`t()` + 英文）：`已覆盖` → Overridden；`恢复继承` → Restore inherited；
`只改这一台设备；其他设备保持原样。`；`已覆盖：只对这一台设备生效。`。设备名复用已有的 `桌面` / `平板` / `手机`。

## 7. 组件测试：没有垫、也没装作有

仓库没有组件测试基建：`vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts`（不含 `.test.tsx`），
依赖里也没有 `@testing-library/react`。按 brief 的兜底要求，**没有**为 `BlockInspector` 现造一套 harness，
而是：

- `writeOverride` 用单元测试覆盖（上面 6 条，含「设备覆盖不改基础块」）；
- 检查器 / `ThemeBuilder` 的接线只经 `tsc --noEmit` 与现有全量测试回归验证，**没有**行为级测试。

## 8. 共享工作树说明

工作树里本来就有一批未提交的改动（`BlockInspector.tsx` 的「组件外观」区块、`ThemeBuilder.tsx` 的文章页
播种与「收起面板」按钮、i18n 片段的既有条目等）。本次只 `git add` 了下面 5 个精确路径，但这些文件里
**先于本任务存在**的未提交内容会随之一起进提交——这是共享工作树决定的，不是本任务夹带。

未改 `styles.css`（它已有 400+ 行未提交改动，不想把别人的样式拖进来）：覆盖提示条与徽标全部复用现有类
（`inspector-children` / `inspector-section-head` / `field-aside` / `badge`），没有新增 CSS。

## 9. 提交

```
feat(web): edit per-device overrides in the inspector
```

阶段化的路径：

```
apps/web/src/lib/layout.ts
apps/web/src/lib/layout.test.ts
apps/web/src/components/builder/BlockInspector.tsx
apps/web/src/pages/admin/ThemeBuilder.tsx
apps/web/src/lib/i18n/dict/fragments/components_builder_BlockInspector.ts
```

（最后一条是 brief 之外的必需改动：新文案要过 `i18n:audit` + `coverage.test.ts` 闸门。）
