import type { LogicChain, LogicStep, ThemeMode } from '../types';

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
  label: '目标组件',
  type: 'block',
  hint: hint ?? '选择首页编排里的一个组件。',
});

export const LOGIC_TRIGGERS: StepDef[] = [
  { type: 'page_load', name: '页面载入', hint: '打开页面时触发一次。', fields: [] },
  {
    type: 'scroll_depth',
    name: '滚动到深度',
    hint: '页面滚动超过一定比例时触发。',
    fields: [{ key: 'depth', label: '滚动深度', type: 'number', min: 5, max: 100, hint: '百分比，5–100。' }],
  },
  {
    type: 'idle',
    name: '用户闲置',
    hint: '用户多久没有操作后触发。',
    fields: [{ key: 'seconds', label: '闲置时长', type: 'number', min: 3, max: 300, hint: '秒。' }],
  },
  { type: 'click_block', name: '点击组件', hint: '读者点击某个组件时触发。', fields: [BLOCK_FIELD()] },
  { type: 'hover_block', name: '悬停组件', hint: '鼠标移到某个组件上时触发。', fields: [BLOCK_FIELD()] },
  { type: 'dark_on', name: '切到深色', hint: '站点切换到深色模式时触发。', fields: [] },
  { type: 'dark_off', name: '切到浅色', hint: '站点切换到浅色模式时触发。', fields: [] },
  { type: 'always', name: '随时', hint: '任何一次求值都触发（适合与条件配合）。', fields: [] },
];

export const LOGIC_CONDITIONS: StepDef[] = [
  { type: 'is_mobile', name: '是手机访问', hint: '视口宽度 < 768px。', fields: [] },
  { type: 'is_desktop', name: '是桌面访问', hint: '视口宽度 ≥ 768px。', fields: [] },
  { type: 'is_logged_in', name: '已登录', hint: '当前有会话。', fields: [] },
  { type: 'is_anonymous', name: '未登录', hint: '访客状态。', fields: [] },
  { type: 'is_personal', name: '是个人博客', hint: '站点形态为个人博客。', fields: [] },
  { type: 'is_dark', name: '当前是深色', hint: '主题模式为深色。', fields: [] },
  { type: 'is_light', name: '当前是浅色', hint: '主题模式为浅色。', fields: [] },
  { type: 'is_home', name: '在首页', hint: '当前路径是首页。', fields: [] },
];

export const LOGIC_ACTIONS: StepDef[] = [
  { type: 'show_block', name: '显示组件', hint: '把被隐藏的组件显示出来。', fields: [BLOCK_FIELD()] },
  { type: 'hide_block', name: '隐藏组件', hint: '临时隐藏一个组件（刷新后恢复配置状态）。', fields: [BLOCK_FIELD()] },
  { type: 'pulse_block', name: '闪烁提醒', hint: '让组件轻轻闪一下，吸引注意。', fields: [BLOCK_FIELD()] },
  {
    type: 'animate_block',
    name: '播放动画',
    hint: '重播一次组件的入场动画。',
    fields: [
      BLOCK_FIELD(),
      {
        key: 'animation',
        label: '动画',
        type: 'select',
        options: [
          { value: 'fade', label: '淡入' },
          { value: 'fade-up', label: '上浮' },
          { value: 'slide-left', label: '左滑' },
          { value: 'slide-right', label: '右滑' },
          { value: 'zoom', label: '放大' },
        ],
      },
    ],
  },
  { type: 'scroll_to_block', name: '滚动到组件', hint: '平滑滚动到某个组件。', fields: [BLOCK_FIELD()] },
  {
    type: 'switch_mode',
    name: '切换深浅模式',
    hint: '切换整站明暗，会写入外观配置。',
    fields: [
      {
        key: 'mode',
        label: '模式',
        type: 'select',
        options: [
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ],
      },
    ],
  },
  { type: 'open_search', name: '打开搜索', hint: '打开全屏搜索浮层。', fields: [] },
  { type: 'open_command', name: '打开命令面板', hint: '打开 Shift+K 命令面板。', fields: [] },
];

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
      return firstEvaluation && ctx.event.kind === 'load' ? '页面载入' : null;
    case 'scroll_depth': {
      if (ctx.event.kind !== 'scroll' && ctx.event.kind !== 'load') return null;
      const depth = Math.min(100, Math.max(5, number(step.config, 'depth', 50)));
      return ctx.scroll * 100 >= depth ? `滚动深度 ${depth}%` : null;
    }
    case 'idle':
      return ctx.event.kind === 'idle' && ctx.idleFor >= number(step.config, 'seconds', 10) * 1000
        ? `闲置 ${number(step.config, 'seconds', 10)} 秒`
        : null;
    case 'click_block':
      return ctx.event.kind === 'click' && matchesBlock(step.config.block_id, ctx.event.blockId)
        ? `点击组件 ${ctx.event.blockId}`
        : null;
    case 'hover_block':
      return ctx.event.kind === 'hover' && matchesBlock(step.config.block_id, ctx.event.blockId)
        ? `悬停组件 ${ctx.event.blockId}`
        : null;
    case 'dark_on':
      return ctx.event.kind === 'dark' && ctx.mode === 'dark' ? '切到深色' : null;
    case 'dark_off':
      return ctx.event.kind === 'dark' && ctx.mode === 'light' ? '切到浅色' : null;
    case 'always':
      return '随时';
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
  if (!triggers.length) return '缺少触发步骤：先选“当…发生时”。';
  if (!actions.length) return '缺少动作步骤：至少选一个“就…”。';
  const firstAction = chain.steps.findIndex((step) => step.kind === 'action');
  const lastTrigger = chain.steps.map((step) => step.kind).lastIndexOf('trigger');
  if (lastTrigger > firstAction) return '触发步骤必须排在动作前面。';
  return '';
}

export function evaluateChain(chain: LogicChain, ctx: LogicContext, firstEvaluation: boolean): LogicEvaluation {
  const log: string[] = [];
  const actions: LogicStep[] = [];
  if (!chain.enabled) return { fired: false, actions, log: ['链条未启用'] };
  const issue = chainIssue(chain);
  if (issue) return { fired: false, actions, log: [issue] };

  let fired = false;
  for (const step of chain.steps) {
    if (step.kind === 'trigger') {
      const reason = triggerMatches(step, ctx, firstEvaluation);
      if (!reason) return { fired: false, actions, log: [`触发「${stepName(step.type)}」未满足`] };
      fired = true;
      log.push(`触发：${reason}`);
    } else if (step.kind === 'condition') {
      if (!conditionHolds(step, ctx)) {
        return { fired: false, actions, log: [...log, `条件「${stepName(step.type)}」不满足，链条中止`] };
      }
      log.push(`条件：${stepName(step.type)} 满足`);
    } else {
      actions.push(step);
    }
  }
  if (!fired) return { fired: false, actions: [], log: ['没有触发步骤'] };
  for (const action of actions) log.push(`动作：${stepName(action.type)}`);
  return { fired: actions.length > 0, actions, log };
}

/** 一句话概括这条链，显示在链条列表里。 */
export function describeChain(chain: LogicChain): string {
  const trigger = chain.steps.find((step) => step.kind === 'trigger');
  const conditions = chain.steps.filter((step) => step.kind === 'condition');
  const actions = chain.steps.filter((step) => step.kind === 'action');
  const parts: string[] = [];
  parts.push(trigger ? `当「${stepName(trigger.type)}」` : '缺少触发');
  if (conditions.length) parts.push(`如果「${conditions.map((step) => stepName(step.type)).join('、')}」`);
  parts.push(actions.length ? `就「${actions.map((step) => stepName(step.type)).join('、')}」` : '没有动作');
  return parts.join('，');
}
