# P1 交接第 3 项：版面迁移的一次性提示 —— 完整报告

- 状态：**完成**（测试、类型检查、i18n 闸门全绿，已提交）
- 分支：`feat/page-builder-v2-p0`
- 提交：`8637d6ba11a15ec6da634ed4831196e799f6f711`
  - `feat(web): tell authors when their layout was migrated`
  - 变更文件（仅此六个，全部为新增行）：
    `apps/web/src/lib/migrationNotice.ts`（新建）、`apps/web/src/lib/migrationNotice.test.ts`（新建）、
    `apps/web/src/lib/customize.ts`、`apps/web/src/lib/customize.test.ts`、
    `apps/web/src/pages/admin/ThemeBuilder.tsx`、`apps/web/src/lib/i18n/dict/fragments/pages_admin_ThemeBuilder.ts`
- 提交统计：`6 files changed, 352 insertions(+)`（0 deletions）

---

## 1. 问题与根因

读取路径（`readCustomization`）现在会做两件**改写作者版面**的事：

1. `migrateCustomization(..., { foldDevices: true })` 把分端编排折算成区块 `at` 覆盖，
   并**删掉被折算的设备树**（`migrate.ts` 的 `foldLayout`）；
2. `normalizeScreenLayout` 把 `width` 像素宽折成栅格 `span`（`migrateWidthsToSpan`）。

迁移器把这些动作写成了人类可读的中文报告（`MigrationResult.report`，例如
`首页：已把手机端与桌面不同的展示设置折算成覆盖。`），但 `readCustomization` 只用了
`migrated.value`，把 `migrated.report` 直接丢掉——作者的布局被重构，却没有任何通知。
规格 §5.1 要求一次性提示。

根因一句话：**报告有生产者、没有传递通道，也没有任何消费者。**

---

## 2. 新模块 `apps/web/src/lib/migrationNotice.ts`

纯模块（不依赖 React、不依赖任何 UI），只做三件事：内存队列、签名、已读记录。

### 2.1 API

| 导出 | 语义 |
| --- | --- |
| `publishMigrationReport(report: string[])` | 存下最近一份**非空**报告（模块内存）。空数组 / 全是空白行时什么都不做，不覆盖已有报告 |
| `takeMigrationReport(): string[]` | 取走并清空；没有报告时返回 `[]` |
| `migrationReportSignature(report: string[]): string` | 稳定短签名：逐行 `join('\n')` 后过 FNV-1a 32 位散列，返回 `长度36进制-散列36进制` |
| `hasSeenMigrationReport(signature): boolean` | 是否已提示过 |
| `markMigrationReportSeen(signature): void` | 记下「已提示过」，重复标记移到队尾 |
| `SEEN_KEY` / `MAX_SEEN_SIGNATURES` | 存储键 `pp.migrationReport.seen.v1`、上限 20 |

### 2.2 为什么报告只在内存、不进 localStorage

- 报告描述的是「**这一次读取**发生了什么」，跨刷新重放没有意义；
- 读取路径**匿名访客也会走**（`visitorBootstrap` 的引导流程、`App.tsx` 的 `setLocale`），
  访客不该被写任何浏览器存储。所以 `customize.ts` 只调用 `publishMigrationReport`，
  **一行 localStorage 都不碰**；「已读」只由后台界面写。

### 2.3 为什么 `take` 要清空

同一会话里可能有两个组件先后挂载读取路径。取走即清空，第二个组件自然拿到 `[]`，
不会两个都弹。这也是「不重复打扰」的第一道闸（第二道是签名，第三道是页面里的会话标记，见 §4.2）。

### 2.4 签名为什么带长度

`migrationReportSignature([])` 与「散列恰好为 0 的非空报告」不会撞在一起；空签名在
`hasSeenMigrationReport` 里一律当作「没看过」（防御未来有人拿空签名去查）。

### 2.5 localStorage 的降级（隐私模式 / 配额）

- `storage()` 自己包 try/catch：Safari 隐私模式下访问 `window.localStorage` 本身就会抛；
- 读失败（坏 JSON、访问被拒）→ `degraded = true`，此后**只走内存**；
- 写失败（`QuotaExceededError` 等）→ 同样 `degraded = true`，但签名已经写进内存，
  所以**同一会话内不会再弹**，只是跨会话不记得；
- `degraded` 是粘性的：混合使用两处存储会出现「刚记下已读、下一次读取只看到旧列表」
  的抖动，进而重复弹窗。

这份设计对应用例：`localStorage.setItem` 抛错时不向外传播，且 `hasSeen` 仍为 `true`。

---

## 3. 读入路径接线（`apps/web/src/lib/customize.ts`，+5 行）

```ts
import { publishMigrationReport } from './migrationNotice';
...
const migrated = migrateCustomization(config.customization, { foldDevices: true });
// 规格 §5.1：折算改写了作者的版面，得让作者知道。报告只交给模块内存（见
// lib/migrationNotice.ts），由后台界面取走做一次性提示。访客的引导流程也会走到
// 这里，所以这里绝不能碰 localStorage——「已读」只由后台界面记录。
publishMigrationReport(migrated.report);
```

- 除这两处外**没有改动读取路径的任何行为**：归一化、`schema_version` 盖章、页面正文
  迁移、CSS 清洗都原样。
- `publishMigrationReport` 自己会忽略空报告，所以「没有迁移 = 没有提示」不需要在这里判断。

---

## 4. 后台弹窗（`apps/web/src/pages/admin/ThemeBuilder.tsx`，+58 行）

### 4.1 挂载时取报告

```tsx
useEffect(() => {
  const report = takeMigrationReport();
  if (!report.length) return;
  const signature = migrationReportSignature(report);
  if (hasSeenMigrationReport(signature) || migrationNoticeShown) return;
  migrationNoticeShown = true;
  setMigrationNotice({ report, signature });
}, []);
```

只在挂载时跑一次；报告为空（已迁移过的站点，绝大多数情况）直接返回，不 setState、不渲染。

### 4.2 为什么还要一个模块级 `migrationNoticeShown`

模块级标记（不是 `useRef`，要跨组件卸载）补上「同一会话」这半边：

- 「已读」是跨会话的持久记录，只在作者点「知道了」之后才写；
- 但 `readCustomization` 会在配置每次变化时重跑（`App.tsx` 的 locale 同步、
  `useCustomization` 的 `useMemo`、`update()` 都会调用），也就是**报告会被重新发布**。
  于是「关掉弹窗却没点知道了、离开编排台再回来」会让它再弹一次。
- 这个标记保证：本次会话提示过就不再自动打开；跨会话仍由 localStorage 的已读签名兜底
  （刷新后若未确认，会再提示一次——这是有意的「直到确认」语义）。

### 4.3 弹窗本体

```tsx
<Modal
  open={!!migrationNotice}
  title={t('版面已自动升级')}
  onClose={dismissMigrationNotice}
  footer={<Button onClick={dismissMigrationNotice}>{t('知道了')}</Button>}
>
  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
    {(migrationNotice?.report ?? []).map((line, index) => (
      <li key={`${index}-${line}`}>{line}</li>
    ))}
  </ul>
</Modal>
```

- 复用文件里已有的 `Modal`（`../../components/ui`）与 `Button`，写法与同一文件里的
  「无代码逻辑链」「恢复默认」两个弹窗一致（`open` / `title` / `onClose` / `footer`）。
- 每条报告一行 `<li>`，文案直接来自迁移器（已经是中文，不是 `t()` 键：它是数据，不是界面文案）。
- 唯一的按钮 `知道了` → `dismissMigrationNotice()`：

```tsx
const dismissMigrationNotice = () => {
  if (migrationNotice) markMigrationReportSeen(migrationNotice.signature);
  setMigrationNotice(null);
};
```

  遮罩、Esc、右上角关闭走的也是同一个 `onClose`，所以任何关闭方式都会记下已读——否则
  用户「关掉但没点按钮」之后刷新还会被再打扰一次。
- 列表样式**写在行内**：`styles.css` 是这个共享工作树里别的会话也在改的全站样式文件，
  不值得为一个三行弹窗正文加一个类（代码里写了这条注释）。

---

## 5. i18n（规格第 5 条闸门）

- 新增两条用户可见文案，都走 `t()`：`版面已自动升级`、`知道了`；
- 英文词条加进 `apps/web/src/lib/i18n/dict/fragments/pages_admin_ThemeBuilder.ts`
  （该文件的片段按源文件拆分，`import.meta.glob` 自动合并）：
  `Your layout was upgraded automatically` / `Got it`；
- 报告正文里的中文来自 `migrate.ts` 的运行时字符串（`${label}：已把…折算成覆盖。`），
  属于**数据**而非界面文案，不参与 `t()` 键表；`scripts/i18n-audit.mjs` 早就在
  `lib/migrate.ts` 记为待迁移，本次没有让它变差。

---

## 6. 测试（新增 10 条）

### 6.1 `apps/web/src/lib/migrationNotice.test.ts`（9 条）

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | publish 之后 take 只交出一次 | 第一次得到两行原文，第二次 `[]` |
| 2 | 空报告不覆盖已有内容 | publish 空数组后 take 仍是原报告；独立 publish 空 → `[]` |
| 3 | 丢掉落空的报告行 | `['首页…', '   ']` → 只留一行 |
| 4 | 相同内容签名相同、与数组实例无关 | 两个不同数组同签名，且形如 `长度-散列` |
| 5 | 内容不同或行数不同签名就变 | 改一个字 / 多一行 / 空数组三种都不同 |
| 6 | 标记后可从 localStorage 读回 | `hasSeen` false → mark → true；存储里就是该签名；别的签名 false |
| 7 | 上限 20，最旧先淘汰 | 连写 25 条 → 存储 20 条、首条 `sig-5`、`sig-0` 已被淘汰 |
| 8 | 重复标记不占两条名额 | `a,b,a` → `['sig-b','sig-a']` |
| 9 | `setItem` 抛错不传播 | `vi.spyOn(localStorage,'setItem').mockImplementation(throw)` 下 `markSeen` 不抛，且 `hasSeen` 仍为 true（内存降级）；末尾 `mockRestore()` |

文件头写明**顺序约束**：第 9 条会让模块 `degraded` 变粘性，所以必须放最后。
每个用例前 `localStorage.clear()` + `takeMigrationReport()`（清掉上一用例留下的模块内存）。

### 6.2 `apps/web/src/lib/customize.test.ts`（新增 1 条，紧邻既有读入用例）

`describe('版面迁移报告')`：

```ts
home = {
  blocks: [block],                       // 与 desktop 完全一样
  device_split: true,
  devices: {
    desktop: { blocks: [block] },
    mobile: { blocks: [{ ...block, animation: 'none' }] },   // 只差一个展示层字段
  },
}
readCustomization({ customization: { home } } as never);
expect(takeMigrationReport()).not.toEqual([]);      // 折算发生了 → 报告非空
expect(report.join('\n')).toContain('首页');
expect(takeMigrationReport()).toEqual([]);          // 取走即清空
```

只差 `animation`（`DISPLAY_KEYS` 成员、不在 `CONTENT_KEYS` 里）→ 走 `foldDisplay` 的
`folded` 分支，产生「已把手机端…折算成覆盖」这条报告，正是本次要接线的场景。

---

## 7. 红/绿证据

1. **i18n 闸门（真实观察到的红）**：第一次全量跑（`npx vitest run`，我的改动只落了一半）
   `src/lib/i18n/coverage.test.ts` 失败，报：
   ```
   - []
   + [ "pages/admin/ThemeBuilder.tsx: 版面已自动升级",
   +   "pages/admin/ThemeBuilder.tsx: 知道了" ]
   ```
   补上片段词条后同一条用例转绿。这条闸门确实会咬人。
2. **接线用例的红**：把 `customize.ts` 里的 `publishMigrationReport(migrated.report);`
   临时改成注释，只跑 `src/lib/customize.test.ts`：
   `Tests 1 failed | 15 passed`，失败点正是
   `expect(report).not.toEqual([])`（`Compared values have no visual difference.`）。
   随即用编辑工具还原，`git status` / `git diff` 对该文件为空（`i/lf w/crlf`，与提交前一致），
   重跑 `customize.test.ts` + `migrationNotice.test.ts` 25 条全绿。全程未用 shell 改写源码。
3. 全量回归：见 §8。

---

## 8. 验证（都在 `apps/web` 下）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | **60 files / 688 tests passed**（基线 59 / 678；新增 1 个测试文件 + 10 条用例） |
| `npm run typecheck`（`tsc --noEmit`） | 干净，无输出 |
| `npm run i18n:audit` | 扫描 168 文件、已包裹 4855、待迁移 193、覆盖率 96.2%；`migrationNotice.ts` 与 `pages/admin/ThemeBuilder.tsx` **都不在待迁移名单**（`--all` 下 grep 无命中） |
| `src/lib/i18n/coverage.test.ts` | 3 条全绿（含「每个 `t()` 键都有英文」「英文里没有中日韩字符」「占位符一一对应」） |

重点回归面（未被破坏）：`customize.test.ts` 其余 15 条（旧正文迁移、区块清洗、外观、CSS 清洗）、
`themeSwitch.test.ts` / `customizeBlocks.test.ts` / `screenLayout.test.ts` / `migrate.test.ts`
（都通过 `readCustomization` 或 `migrateCustomization` 间接吃到本次接线，全绿）。

---

## 9. 提交与仓库卫生

- 只提交六个精确路径（见头部），**未**使用 `git add -A` / `git stash` / `git checkout -- .`。
- 提交前逐一核对 `git diff`：
  - `customize.ts`（5 增）与 `ThemeBuilder.tsx`（58 增）当时**整份 diff 都是我的**，
    所以按精确路径 `git add` 等价于「只加我的 hunk」；
  - `customize.test.ts`（工作树里另有别人的 `区块通用外观` / `custom_css 内容规范化` 两个 describe，
    以及多行 import 改写）与 `i18n/dict/fragments/pages_admin_ThemeBuilder.ts`（另有
    `收起面板`/`展开面板` 三条词条）**确实夹着别人的 hunk**，只暂存我的部分。
- 这两个夹带文件的做法（如实记录踩到的坑）：
  - 片段文件用「手写 LF 补丁 + `git apply --cached --recount`」成功，暂存后 `git diff --cached`
    只有我加的三行（`版面已自动升级` / `知道了` + 注释）。
  - `customize.test.ts` 上 `git apply --cached` 反复失败（`patch does not apply`，连
    `@@ -1,1 +1,2 @@` 这种只匹配首行的最小补丁也失败；已排除 BOM、CRLF、`.gitattributes`、
    嵌套 attributes、`core.autocrlf` 等因素——`git diff` 生成的同内容补丁却能应用，
    疑为 `* text=auto` 与 `git apply --cached` 的已知交互）。改为**不依赖 patch** 的确定性做法：
    1. `git cat-file -p HEAD:<path> > %TEMP%\head-cs-test.ts`（cmd 重定向，字节原样，LF）；
    2. Node 脚本把「我的 import 行 + 我的 describe」拼到 HEAD 版本上，生成目标文件；
    3. `git hash-object -w <目标文件>` → `git update-index --cacheinfo 100644,<sha>,<path>`。
    验证：`git diff --cached --stat` 显示该文件 **+38 -0**，与树内其它会话的 hunk 完全无关；
    目标文件与 HEAD 的 `--no-index` diff 正好是这 38 行。
- `git diff --cached --check` 干净（无空白/CRLF 报错）；提交后
  `git show --stat HEAD` 只有这六个文件。
- 提交后工作树状态：`customize.ts` / `ThemeBuilder.tsx` / 两个新文件为 clean；
  `customize.test.ts`、`pages_admin_ThemeBuilder.ts` 仍显示 ` M`——那是**别人未提交的 hunk**，
  本次没有触碰、也不会替别人提交。

---

## 10. 观察与建议（本次未越界改动）

1. **报告会被反复发布**：`readCustomization` 在配置每次变化时都会跑（`App.tsx` 的 locale
   effect、`useCustomization` 的 `useMemo`、`update()`），所以报告会反复回到内存队列。
   页面里的 `migrationNoticeShown` 已经把用户侧影响收住了；但更好的做法是让读取路径只在
   「真的折算了新的东西」时发布（例如由 `customize.ts` 缓存上一次已发布的签名，签名相同就不重发）。
   这需要给 `migrationNotice` 加一个「发布去重」的内建逻辑，属于接口扩展，本次未做。
2. **`takeMigrationReport` 是单消费者语义**：两处 UI 若都想展示同一份报告，第二个会拿到 `[]`。
   如果以后前台也要提示（例如访客看到自己的站点被改），建议改成 `peekMigrationReport()` +
   显式 `dismiss`，并把「已读」从「一次消费」升级成「按签名确认」。
3. **签名是 32 位散列**：不同报告理论上会碰撞，代价是少提示一次（不会多打扰）。如果以后想
   把它当审计凭据用，应换成 SHA-256 前缀 + 保留完整报告文本。
4. **弹窗依赖读取路径先跑过一次**：`ThemeBuilder` 挂载时 `useCustomization()` 已经在 render 阶段
   调过 `readCustomization`，加上 `App.tsx` 的 locale effect，报告通常已就位。但若将来 `ThemeBuilder`
   能在配置加载前渲染（例如路由懒加载 + 首屏无 config），挂载时的 `take` 会拿到空数组。
   到那时应改成「响应 `customization` 变化再取一次」，代价是要处理重复弹窗（本文件已有会话标记可复用）。
