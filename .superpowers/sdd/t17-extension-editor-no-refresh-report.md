# T17：扩展编辑不刷新（后台交互）

**范围**：后台「扩展」页的修改体验——启停 / 改配置 / 保存后页面就地更新，不整页刷新、
不弹刷新提示；保留列表选中项、表单内容与滚动；保存后编辑器不丢焦点与光标；iframe
预览失败只影响预览。用户组与扩展接口文档属于其它工单，本报告不涉及。

## 一、改动前的定位与证据

1. `apps/web/src/pages/admin/Extensions.tsx` 里「我的扩展」只有导入 JSON、启停开关、
   复制、导出、删除；**没有任何 HTML / CSS / JS 编辑入口**。因此「编辑扩展后要刷新」
   在当时不是某一行代码的 bug，而是缺了「就地编辑」这个界面。
2. 现有写入链路本身不刷新：`useCustomization().update()` → `updateConfig` 只改
   `localStorage` + 触发 `scheduleCustomizationSave` 防抖写回，不导航、不 reload。
   `apps/web/src/lib/customizationSync.ts` 的保存失败只写 console，不会弹「请刷新」。
3. 全链路 grep `location.reload|location.href` 在扩展相关文件里无命中。唯一的
   「刷新页面会回到服务端保存的版本」提示在 `apps/web/src/lib/siteConfigSave.ts`，
   属于站点级配置保存失败的兜底，与本工单的扩展编辑无关。
4. 因此本工单的交付是：补上就地编辑（工坊），并让「编辑 → 预览 → 保存 → 列表更新」
   全程停留在当前页面。

## 二、交互设计（为什么不刷新）

- **工坊是叠加在列表上的弹窗**（`Modal`）：tab、卡片列表、选中高亮与页面滚动位置都
  留在原地；关闭后原样返回。
- **草稿只在组件 state 里**：改名称、槽位、页面、权限、HTML / CSS / JS 都不写站点
  设计，也不导航；只有点「更新 / 保存为我的扩展」或 Ctrl/Cmd+S 才提交。
- **保存只替换同一条清单**：`update({ custom_extensions })` 用同 id 换掉数组元素，
  React 就地重渲染卡片，选中项（`selectedId`）不变。
- **工坊不重建**：`ExtensionStudio` 的 `key` 只在「打开另一张卡 / 新建」时变化；保存
  后 key 不变，组件不卸载 → 输入框节点、焦点、光标、两栏滚动都保留。父组件在保存后
  把落盘清单回传给 `saved`，工坊用它收敛草稿（截断 / trim），同值时不会重写
  `textarea` 的 DOM，光标原地不动。
- **Ctrl/Cmd+S 就地保存**：不移动焦点，保存后光标仍在代码框里（单测覆盖).
- **启停就地生效**：列表开关和工坊内的启用开关都走同一条 `update`；`updated_at` 变化
  只让前台 iframe 重挂（让新脚本生效），不影响本页。
- **新建后不换 key**：首次保存新建扩展时只把 `savedId` 指向新 id，工坊保持挂载，
  标签从「保存为我的扩展」变成「更新」，光标与滚动不退。

## 三、预览失败隔离

- `PreviewBoundary`（错误边界）**只包预览 iframe**：`buildExtensionDocument` 或宿主
  渲染抛错时，只有预览区退回兜底提示，表单、保存按钮、列表全部照常。
- 8 秒未 `load` 的兜底计时器同样只处理预览。
- 失败时 toast「扩展预览失败」，预览回退到**上次保存的清单**；未保存的表单内容保留，
  修好之后（草稿变化）自动重新预览。
- 错误边界与加载兜底共用 `failureRef` 去重，同一次失败只 toast 一次。
- `ExtensionHost` 新增可选 `onLoad` / `onError`，只用于编辑器判断沙箱是否真的跑起来。

## 四、文件清单

新增：

- `apps/web/src/components/ExtensionStudio.tsx`：工坊（清单 + 代码 + 沙箱预览 + 保存）。
- `apps/web/src/lib/extensionDraft.ts`：草稿纯函数（脏判断、校验、勾选顺序、保存收敛）。
- `apps/web/src/lib/i18n/dict/fragments/components_ExtensionStudio.ts`：新增文案英文。
- `apps/web/src/components/ExtensionStudio.test.ts`：保存不重建 / Ctrl+S 保光标 /
  勾选槽位 / 模板覆盖确认 / 新建必填。
- `apps/web/src/components/ExtensionStudioPreviewFailure.test.ts`：预览抛错仍可保存。
- `apps/web/src/lib/extensionDraft.test.ts`：草稿逻辑 24 个用例。
- `apps/web/src/lib/extensionEditingRefresh.test.ts`：静态闸门——扩展编辑链路里没有
  `location.reload/assign/replace`、没有 `location.href =`、没有「请刷新」文案。

修改：

- `apps/web/src/pages/admin/Extensions.tsx`：新增「新建扩展」「编辑」入口、选中高亮、
  就地保存与删除时关闭工坊；列表与 tab 不重建。
- `apps/web/src/styles/extensions.css`：工坊两栏布局、勾选胶囊、代码框、预览栏、
  选中卡片与窄屏样式。
- `apps/web/src/components/ExtensionHost.tsx`：`onLoad` / `onError` 可选回调。

## 五、验证

### 自动

在 `apps/web` 下（本机 `npx` 受执行策略限制，用 node 直接调本地依赖）：

```powershell
node node_modules\typescript\bin\tsc --noEmit          # 通过（exit 0）
node node_modules\vitest\vitest.mjs run               # 98 个测试文件 / 1180 个用例全部通过
node node_modules\vitest\vitest.mjs run src/components/ExtensionStudio.test.ts `
  src/components/ExtensionStudioPreviewFailure.test.ts src/lib/extensionDraft.test.ts `
  src/lib/extensionEditingRefresh.test.ts             # 33 个用例通过
node node_modules\vite\bin\vite.js build              # 通过
```

> `vite build` 若报 `[vite:esbuild-transpile] remove ...\Temp\esbuild-... Access is denied`，
> 是本机临时目录不允许删除 esbuild 产物导致的环境问题；把 `TMP`/`TEMP` 指到工作区内
> 再跑即可成功（本次已验证 `✓ built`）。

### 手动（`npm run dev`）

1. 后台 →「扩展」→「我的扩展」→ 任意卡片「编辑」（或右上「新建扩展」）。
2. 在 HTML 代码框输入：右栏约 300ms 后重建预览；**地址栏不变、页面不重载**（DevTools
   Network 里没有 document 请求，排除 XHR/fetch）。
3. 勾选/取消槽位、页面、权限，改名称与说明——列表在弹窗后面保持原样。
4. 点「更新」或按 Ctrl+S：toast「扩展已更新」；列表卡片就地刷新并保持选中；弹窗不关；
   HTML 框的焦点与光标位置不变；关闭弹窗后页面滚动位置不变。
5. 在列表上切换启停：卡片徽标与开关即时变化，页面不刷新。
6. 预览失败（例如在扩展 JS 里写一句必抛的语法错误）：只有预览区回退 + 一条错误 toast；
   表单仍可编辑，仍可保存。

## 六、已知边界 / 未完成

- 关闭工坊会丢弃未保存草稿（没有二次确认）；仅在有内容时对「插入示例模板」做了覆盖
  确认。若需要「关闭前确认」，可复用同一套内联确认。
- 保存后的服务端写回仍沿用现有 `customizationSync` 防抖（失败静默），本次没有改它的
  重试 / 冲突策略。
- 用户组（另一工单）与扩展接口文档（另一工单）未触碰。
