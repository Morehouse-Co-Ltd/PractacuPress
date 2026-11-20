/**
 * 站点中英双语内核。
 *
 * 设计要点：**中文原文就是键**。`t('站点设置')` 在简体中文下原样返回，
 * 在英文下查 `dict/` 里的英文表。这样迁移只是把现有中文包一层 `t()`，
 * 中文输出一个字都不变，既有页面、测试与视觉都没有回归风险。
 *
 * 语言是站点级设置（存在 `SiteCustomization.language`），不是访客级偏好。
 *
 * 用法：
 * - 组件里 `const t = useT()` —— 订阅语言变化，切换后自动重渲染；
 * - 非组件模块（`format.ts`、`blocks.ts` 之类）直接 `import { t }`；
 * - 弹错误提示用 `errorText(err)`，英文下会按 `problem.code` 映射，
 *   不会把 Go 服务端的中文 message 直接丢给英文用户。
 */

import { useSyncExternalStore } from 'react';
import type { ProblemBody } from '../../types';
import { problemDetail, problemDetailText } from '../problemDetail';
import { DICT } from './dict';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from './locales';
import { interpolate, pickPlural, type Entry, type Vars } from './plural';

export type { Locale, LocaleOption } from './locales';
export type { Entry, Vars } from './plural';
export { DEFAULT_LOCALE, LOCALES, isLocale, normalizeLocale } from './locales';

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** `<html lang>` 跟着语言走：屏幕阅读器、断词与字体回退都依赖它。 */
export function applyDocumentLocale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
}

/**
 * 切换语言。
 *
 * 重复设置同一个语言也会同步一次 `lang` 属性（首次启动时要用到），
 * 但不会通知订阅者，避免无谓的重渲染。
 */
export function setLocale(next: unknown): void {
  const locale = normalizeLocale(next);
  if (locale === current) {
    applyDocumentLocale();
    return;
  }
  current = locale;
  applyDocumentLocale();
  for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function lookup(text: string): Entry | undefined {
  return DICT[text];
}

/**
 * 取当前语言的文案。
 *
 * - 中文：原样返回（仍做插值，因为中文句子也可能带 `{n}` 占位）；
 * - 英文：查表，查不到就回退中文原文，并在开发环境告警——绝不显示空串。
 */
export function t(text: string, vars?: Vars): string {
  if (current === 'zh-CN') return interpolate(text, vars);
  const entry = lookup(text);
  if (entry === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] 缺少英文条目：${text}`);
    return interpolate(text, vars);
  }
  const pattern = typeof entry === 'string' ? entry : pickPlural(entry, vars);
  return interpolate(pattern, vars);
}

/** 组件内使用：语言变化时重渲染。 */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return t;
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/**
 * 后端错误码的英文文案。
 *
 * Go 侧只保证 `code` 稳定，message 允许本地化；所以英文界面按码翻译，
 * 未收录的码回退服务端原文（中文），宁可显示中文也不显示空错误。
 */
const ERROR_MESSAGE_EN: Record<string, string> = {
  validation_failed: 'The request did not pass validation.',
  unauthenticated: 'Your session has expired. Please sign in again.',
  permission_denied: 'Your account is not allowed to do this.',
  not_found: 'The requested resource does not exist.',
  conflict: 'The resource changed. Refresh and try again.',
  rate_limited: 'Too many requests. Please slow down and try again.',
  internal: 'The service is temporarily unavailable.',
  invalid_cursor: 'This page cursor is no longer valid.',
  idempotency_key_reuse: 'The same idempotency key was used for a different request.',
  site_not_found: 'This site does not exist or is not available here.',
  site_domain_unverified: 'This domain has not been verified for the site yet.',
  content_state_invalid: 'The content is not in a state that allows this action.',
  security_unavailable: 'In-process security checks are unavailable; the action is queued.',
  provider_not_configured: 'This sign-in provider is not configured.',
  invalid_database_driver: 'The database driver is not supported.',
  email_not_configured: 'Outgoing email is not configured.',
};

function codeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const problem = (err as { problem?: unknown }).problem;
  if (problem && typeof problem === 'object') {
    const code = (problem as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  const direct = (err as { code?: unknown }).code;
  return typeof direct === 'string' && direct ? direct : null;
}

/**
 * 取异常随身的响应体（`ApiError.problem`，或直接就是一个 problem 对象）。
 *
 * `validation_failed` 的 `message` 是固定的「请求参数不符合要求」，真正的原因在
 * `details.field` / `details.rule` 里；`problemDetailText` 负责把它翻成人话。
 */
function problemOf(err: unknown): ProblemBody | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = (err as { problem?: unknown }).problem;
  const source = candidate && typeof candidate === 'object' ? candidate : err;
  const record = source as { code?: unknown; details?: unknown };
  if (typeof record.code !== 'string' || !record.details || typeof record.details !== 'object') {
    return null;
  }
  return source as ProblemBody;
}

/**
 * 取异常自带的 message。
 *
 * 真实错误是 `Error`；测试、`Promise.reject({…})` 或未来客户端可能给一个带
 * `message` 的普通对象，也要认，不能退化成 `[object Object]`。
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    const problem = (err as { problem?: unknown }).problem;
    if (problem && typeof problem === 'object') {
      const problemMessage = (problem as { message?: unknown }).message;
      if (typeof problemMessage === 'string' && problemMessage) return problemMessage;
    }
  }
  if (err === undefined || err === null) return '';
  return String(err);
}

/**
 * 把任意异常变成当前语言的提示文案。
 *
 * 顺序：
 * 1. `validation_failed` 且带 `details.field`/`rule` → 说清是哪个字段错了（中英都走这一条）；
 * 2. 英文下按错误码给通用英文（避免把服务端中文丢给英文用户）；
 * 3. 其它一律回退异常自带的 message。
 */
export function errorText(err: unknown): string {
  if (!err) return '';
  if (codeOf(err) === 'validation_failed') {
    const specific = problemDetailText(problemDetail(problemOf(err)), t);
    if (specific) return specific;
  }
  if (current === 'en') {
    const code = codeOf(err);
    const mapped = code ? ERROR_MESSAGE_EN[code] : undefined;
    if (mapped) return mapped;
  }
  return messageOf(err);
}
