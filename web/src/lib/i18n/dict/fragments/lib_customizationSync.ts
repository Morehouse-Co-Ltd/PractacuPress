import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/lib/customizationSync.ts`
 *
 * 这个模块没有界面文案可译：中文只出现在控制台诊断里——
 * - `consoleSyncLogger` 的 `[站点设计]` 前缀；
 * - `logger.warn(...)` 的消息（「读取站点设计被拒绝，继续使用本地缓存。」等）；
 * - `blockedReason()` 返回、随后交给 `logger.warn` 的说明文字。
 *
 * `App.tsx` 调用 `hydrateCustomization` / `scheduleCustomizationSave` 时都不注入
 * logger，所以这些字符串只会进浏览器控制台，从不进入界面。按迁移规则（只包界面
 * 文案、控制台消息保持原样），本片段为空。
 *
 * 如果将来把 logger 接到界面提示（toast、横幅），需要先在这些消息外加 `t()`，
 * 再回到这里补英文。
 *
 * `node scripts/i18n-audit.mjs --all` 仍会为这个文件报 13 条待迁移（2 处
 * `[站点设计]` 前缀、11 条 `logger.warn` / `blockedReason` 消息）。审计脚本只做
 * 正则统计，按设计偏保守；这里逐条走过一遍：没有一条进入界面，也没有一条被
 * `toast` / `confirm` / `aria-label` / `useTitle` 消费，属于「控制台诊断」，
 * 按迁移规则保持中文。
 */
const fragment: Dictionary = {};

export default fragment;
