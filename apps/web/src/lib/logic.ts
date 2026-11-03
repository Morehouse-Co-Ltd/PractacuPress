import type { LogicChain, LogicStep, ThemeMode } from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';
import { BREAKPOINT_MD } from './layout';

/**
 * 思维链引擎（无代码逻辑）。
 *
 * 一条链 = 一个触发 + 若干条件 + 若干动作：当触发发生的事情满足全部条件时，
 * 按顺序执行动作。整条链是纯数据，由 `evaluateChain` 求值——
 * 不 eval、不动态生成代码，因此无代码产物不会有脚本注入面，也不会更慢。
 */

export interface LogicEvent {
  kind: 'load' | 'scroll' | 'idle' | 'click' | 'hover' | 'dark';
  blockId?: string;
}

export interface LogicContext {
  pathname: string;
  isMobile: boolean;
  loggedIn: boolean;
  personal: boolean;
  mode: ThemeMode;
  /** 页面滚动进度 0–1。 */
  scroll: number;
  /** 用户多久没有交互，毫秒。 */
  idleFor: number;
  event: LogicEvent;
}

export interface LogicEvaluation {
  fired: boolean;
  actions: LogicStep[];
  /** 人读的解释，试运行时显示。 */
  log: string[];
}

/* ---------------- 步骤目录（驱动后台表单与运行时） ---------------- */

export interface StepField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'block';
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

export interface StepDef {
  type: string;
  name: string;
  hint: string;
  fields: StepField[];
}

const BLOCK_FIELD = (hint?: string): StepField => ({
  key: 'block_id',
  label: t('目标组件'),
  type: 'block',
  hint: hint ?? t('选择首页编排里的一个组件。'),
});

const RAW_LOGIC_TRIGGERS: StepDef[] = [
  { type: 'page_load', name: t('页面载入'), hint: t('打开页面时触发一次。'), fields: [] },
  {
    type: 'scroll_depth',
    name: t('滚动到深度'),
    hint: t('页面滚动超过一定比例时触发。'),
    fields: [{ key: 'depth', label: t('滚动深度'), type: 'number', min: 5, max: 100, hint: t('百分比，5–100。') }],
  },
  {
    type: 'idle',
    name: t('用户闲置'),
    hint: t('用户多久没有操作后触发。'),
    fields: [{ key: 'seconds', label: t('闲置时长'), type: 'number', min: 3, max: 300, hint: t('秒。') }],
  },
  { type: 'click_block', name: t('点击组件'), hint: t('读者点击某个组件时触发。'), fields: [BLOCK_FIELD()] },
  { type: 'hover_block', name: t('悬停组件'), hint: t('鼠标移到某个组件上时触发。'), fields: [BLOCK_FIELD()] },
  { type: 'dark_on', name: t('切到深色'), hint: t('站点切换到深色模式时触发。'), fields: [] },
  { type: 'dark_off', name: t('切到浅色'), hint: t('站点切换到浅色模式时触发。'), fields: [] },
  { type: 'always', name: t('随时'), hint: t('任何一次求值都触发（适合与条件配合）。'), fields: [] },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const LOGIC_TRIGGERS = liveCatalog(RAW_LOGIC_TRIGGERS);

/**
 * `is_mobile` / `is_desktop` 的提示文案。
 *
 * 阈值与编排器共用同一张断点表（`lib/layout.ts` 的 `BREAKPOINT_MD`），
 * 文案里的数字由常量拼出，改断点时提示不会和实际行为脱节。
 */
const MOBILE_HINT = `视口宽度 < ${BREAKPOINT_MD}px。`;
const DESKTOP_HINT = `视口宽度 ≥ ${BREAKPOINT_MD}px。`;

const RAW_LOGIC_CONDITIONS: StepDef[] = [
  { type: 'is_mobile', name: t('是手机访问'), hint: t(MOBILE_HINT), fields: [] },
  { type: 'is_desktop', name: t('是桌面访问'), hint: t(DESKTOP_HINT), fields: [] },
  { type: 'is_logged_in', name: t('已登录'), hint: t('当前有会话。'), fields: [] },
  { type: 'is_anonymous', name: t('未登录'), hint: t('访客状态。'), fields: [] },
  { type: 'is_personal', name: t('是个人博客'), hint: t('站点形态为个人博客。'), fields: [] },
  { type: 'is_dark', name: t('当前是深色'), hint: t('主题模式为深色。'), fields: [] },
  { type: 'is_light', name: t('当前是浅色'), hint: t('主题模式为浅色。'), fields: [] },
  { type: 'is_home', name: t('在首页'), hint: t('当前路径是首页。'), fields: [] },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const LOGIC_CONDITIONS = liveCatalog(RAW_LOGIC_CONDITIONS);

const RAW_LOGIC_ACTIONS: StepDef[] = [
  { type: 'show_block', name: t('显示组件'), hint: t('把被隐藏的组件显示出来。'), fields: [BLOCK_FIELD()] },
  { type: 'hide_block', name: t('隐藏组件'), hint: t('临时隐藏一个组件（刷新后恢复配置状态）。'), fields: [BLOCK_FIELD()] },
  { type: 'pulse_block', name: t('闪烁提醒'), hint: t('让组件轻轻闪一下，吸引注意。'), fields: [BLOCK_FIELD()] },
  {
    type: 'animate_block',
    name: t('播放动画'),
    hint: t('重播一次组件的入场动画。'),
    fields: [
      BLOCK_FIELD(),
      {
        key: 'animation',
        label: t('动画'),
        type: 'select',
        options: [
          { value: 'fade', label: t('淡入') },
          { value: 'fade-up', label: t('上浮') },
          { value: 'slide-left', label: t('左滑') },
          { value: 'slide-right', label: t('右滑') },
          { value: 'zoom', label: t('放大') },
        ],
      },
    ],
  },
  { type: 'scroll_to_block', name: t('滚动到组件'), hint: t('平滑滚动到某个组件。'), fields: [BLOCK_FIELD()] },
  {
    type: 'switch_mode',
    name: t('切换深浅模式'),
    hint: t('切换整站明暗，会写入外观配置。'),
    fields: [
      {
        key: 'mode',
        label: t('模式'),
        type: 'select',
        options: [
          { value: 'light', label: t('浅色') },
          { value: 'dark', label: t('深色') },
        ],
      },
    ],
  },
  { type: 'open_search', name: t('打开搜索'), hint: t('打开全屏搜索浮层。'), fields: [] },
  { type: 'open_command', name: t('打开命令面板'), hint: t('打开 Shift+K 命令面板。'), fields: [] },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const LOGIC_ACTIONS = liveCatalog(RAW_LOGIC_ACTIONS);

export const STEP_DEFS: Record<string, StepDef> = Object.fromEntries(
  [...LOGIC_TRIGGERS, ...LOGIC_CONDITIONS, ...LOGIC_ACTIONS].map((item) => [item.type, item]),
);

export function stepName(type: string): string {
  return STEP_DEFS[type]?.name ?? type;
}

/* ---------------- 求值 ---------------- */

function number(config: Record<string, string | number | boolean>, key: string, fallback: number): number {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function triggerMatches(step: LogicStep, ctx: LogicContext, firstEvaluation: boolean): string | null {
  switch (step.type) {
    case 'page_load':
      return firstEvaluation && ctx.event.kind === 'load' ? t('页面载入') : null;
    case 'scroll_depth': {
      if (ctx.event.kind !== 'scroll' && ctx.event.kind !== 'load') return null;
      const depth = Math.min(100, Math.max(5, number(step.config, 'depth', 50)));
      return ctx.scroll * 100 >= depth ? t('滚动深度 {depth}%', { depth }) : null;
    }
    case 'idle':
      return ctx.event.kind === 'idle' && ctx.idleFor >= number(step.config, 'seconds', 10) * 1000
        ? t('闲置 {seconds} 秒', { seconds: number(step.config, 'seconds', 10) })
        : null;
    case 'click_block':
      return ctx.event.kind === 'click' && matchesBlock(step.config.block_id, ctx.event.blockId)
        ? t('点击组件 {blockId}', { blockId: ctx.event.blockId ?? '' })
        : null;
    case 'hover_block':
      return ctx.event.kind === 'hover' && matchesBlock(step.config.block_id, ctx.event.blockId)
        ? t('悬停组件 {blockId}', { blockId: ctx.event.blockId ?? '' })
        : null;
    case 'dark_on':
      return ctx.event.kind === 'dark' && ctx.mode === 'dark' ? t('切到深色') : null;
    case 'dark_off':
      return ctx.event.kind === 'dark' && ctx.mode === 'light' ? t('切到浅色') : null;
    case 'always':
      return t('随时');
    default:
      return null;
  }
}

function matchesBlock(wanted: unknown, actual: string | undefined): boolean {
  if (!actual) return false;
  if (wanted === '*' || wanted === '') return true;
  return wanted === actual;
}

function conditionHolds(step: LogicStep, ctx: LogicContext): boolean {
  switch (step.type) {
    case 'is_mobile':
      return ctx.isMobile;
    case 'is_desktop':
      return !ctx.isMobile;
    case 'is_logged_in':
      return ctx.loggedIn;
    case 'is_anonymous':
      return !ctx.loggedIn;
    case 'is_personal':
      return ctx.personal;
    case 'is_dark':
      return ctx.mode === 'dark';
    case 'is_light':
      return ctx.mode === 'light';
    case 'is_home':
      return ctx.pathname === '/';
    default:
      return true;
  }
}

/** 链条是否结构合法：至少一个触发与一个动作，且触发在动作之前。 */
export function chainIssue(chain: LogicChain): string {
  const triggers = chain.steps.filter((step) => step.kind === 'trigger');
  const actions = chain.steps.filter((step) => step.kind === 'action');
  if (!triggers.length) return t('缺少触发步骤：先选“当…发生时”。');
  if (!actions.length) return t('缺少动作步骤：至少选一个“就…”。');
  const firstAction = chain.steps.findIndex((step) => step.kind === 'action');
  const lastTrigger = chain.steps.map((step) => step.kind).lastIndexOf('trigger');
  if (lastTrigger > firstAction) return t('触发步骤必须排在动作前面。');
  return '';
}

export function evaluateChain(chain: LogicChain, ctx: LogicContext, firstEvaluation: boolean): LogicEvaluation {
  const log: string[] = [];
  const actions: LogicStep[] = [];
  if (!chain.enabled) return { fired: false, actions, log: [t('链条未启用')] };
  const issue = chainIssue(chain);
  if (issue) return { fired: false, actions, log: [issue] };

  let fired = false;
  for (const step of chain.steps) {
    if (step.kind === 'trigger') {
      const reason = triggerMatches(step, ctx, firstEvaluation);
      if (!reason) return { fired: false, actions, log: [t('触发「{name}」未满足', { name: stepName(step.type) })] };
      fired = true;
      log.push(t('触发：{reason}', { reason }));
    } else if (step.kind === 'condition') {
      if (!conditionHolds(step, ctx)) {
        return {
          fired: false,
          actions,
          log: [...log, t('条件「{name}」不满足，链条中止', { name: stepName(step.type) })],
        };
      }
      log.push(t('条件：{name} 满足', { name: stepName(step.type) }));
    } else {
      actions.push(step);
    }
  }
  if (!fired) return { fired: false, actions: [], log: [t('没有触发步骤')] };
  for (const action of actions) log.push(t('动作：{name}', { name: stepName(action.type) }));
  return { fired: actions.length > 0, actions, log };
}

/** 一句话概括这条链，显示在链条列表里。 */
export function describeChain(chain: LogicChain): string {
  const trigger = chain.steps.find((step) => step.kind === 'trigger');
  const conditions = chain.steps.filter((step) => step.kind === 'condition');
  const actions = chain.steps.filter((step) => step.kind === 'action');
  const parts: string[] = [];
  parts.push(trigger ? t('当「{name}」', { name: stepName(trigger.type) }) : t('缺少触发'));
  if (conditions.length) {
    const names = conditions.map((step) => stepName(step.type)).join(t('、'));
    parts.push(t('如果「{names}」', { names }));
  }
  if (actions.length) {
    const names = actions.map((step) => stepName(step.type)).join(t('、'));
    parts.push(t('就「{names}」', { names }));
  } else {
    parts.push(t('没有动作'));
  }
  return parts.join(t('，'));
}
