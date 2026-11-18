import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { LogicStep } from '../types';
import { useAuth } from '../lib/session';
import { useCustomization, useThemeMode } from '../lib/customize';
import { isPersonalSite } from '../lib/site';
import { setThemePreference } from '../lib/themePreference';
import { runThemeTransition } from '../lib/themeTransition';
import { dispatchInterfaceCommand } from '../lib/interfaceCommands';
import { evaluateChain, type LogicContext, type LogicEvent } from '../lib/logic';
import { BREAKPOINT_MD } from '../lib/layout';

/**
 * 思维链运行时。
 *
 * 性能纪律：
 * - 只挂“有链条用到”的监听器（滚动 / 悬停 / 点击 / 闲置各至多一个）；
 * - 滚动用 rAF 节流，监听器全部 passive；
 * - 每条链 1.5 秒冷却，防止悬停与滚动把动作放成刷屏；
 * - 动作只操作 DOM class 与滚动，不触发 React 重渲染（切模式除外）。
 */

const COOLDOWN = 1500;

function blockEl(id: unknown): HTMLElement | null {
  if (typeof id !== 'string' || !id) return null;
  try {
    return document.querySelector<HTMLElement>(`[data-pp-block="${CSS.escape(id)}"]`);
  } catch {
    return null;
  }
}

function applyAction(step: LogicStep, switchMode: (mode: 'light' | 'dark') => void) {
  switch (step.type) {
    case 'show_block': {
      const el = blockEl(step.config.block_id);
      el?.classList.remove('is-logic-hidden');
      break;
    }
    case 'hide_block': {
      const el = blockEl(step.config.block_id);
      el?.classList.add('is-logic-hidden');
      break;
    }
    case 'pulse_block': {
      const el = blockEl(step.config.block_id);
      if (!el) break;
      el.classList.remove('is-pulse');
      // 强制回流，让同一节点可以连续闪烁。
      void el.offsetWidth;
      el.classList.add('is-pulse');
      window.setTimeout(() => el.classList.remove('is-pulse'), 1200);
      break;
    }
    case 'animate_block': {
      const el = blockEl(step.config.block_id);
      const animation = typeof step.config.animation === 'string' ? step.config.animation : 'fade-up';
      if (!el) break;
      el.classList.remove('pp-anim-fade', 'pp-anim-fade-up', 'pp-anim-slide-left', 'pp-anim-slide-right', 'pp-anim-zoom', 'is-in');
      void el.offsetWidth;
      el.classList.add('pp-anim', `pp-anim-${animation}`, 'is-in');
      break;
    }
    case 'scroll_to_block': {
      const el = blockEl(step.config.block_id);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
    case 'switch_mode': {
      switchMode(step.config.mode === 'dark' ? 'dark' : 'light');
      break;
    }
    case 'open_search':
      dispatchInterfaceCommand('search');
      break;
    case 'open_command':
      dispatchInterfaceCommand('command');
      break;
    default:
      break;
  }
}

export function LogicRuntime() {
  const { customization } = useCustomization();
  const { me, config } = useAuth();
  const location = useLocation();
  const chains = customization.logic.chains;
  // 条件里读实际看到的模式（Cookie 偏好优先），不是站点默认值。
  const { mode } = useThemeMode();

  // 滚动 / 闲置 / 交互状态放在 ref 里，求值时不触发重渲染。
  const scrollRef = useRef(0);
  const idleRef = useRef(0);
  const lastFiredRef = useRef<Record<string, number>>({});
  const firstRef = useRef(true);

  const enabled = chains.filter((chain) => chain.enabled);
  const uses = (type: string) => enabled.some((chain) => chain.steps.some((s) => s.kind === 'trigger' && s.type === type));
  const needs = {
    scroll: uses('scroll_depth'),
    idle: uses('idle'),
    pointer: uses('click_block') || uses('hover_block'),
    dark: uses('dark_on') || uses('dark_off'),
  };

  // 用 ref 持有最新值，监听器不必随配置变化重建。
  const latest = useRef({ chains, mode, loggedIn: !!me, personal: isPersonalSite(config), pathname: location.pathname, theme: customization.theme });
  latest.current = { chains, mode, loggedIn: !!me, personal: isPersonalSite(config), pathname: location.pathname, theme: customization.theme };

  useEffect(() => {
    if (!chains.length) return;

    const runChains = (event: LogicEvent, first: boolean) => {
      const state = latest.current;
      const ctx: LogicContext = {
        pathname: state.pathname,
        isMobile: window.innerWidth < BREAKPOINT_MD,
        loggedIn: state.loggedIn,
        personal: state.personal,
        mode: state.mode,
        scroll: scrollRef.current,
        idleFor: idleRef.current,
        event,
      };
      for (const chain of state.chains) {
        if (!chain.enabled) continue;
        const now = Date.now();
        const last = lastFiredRef.current[chain.id] ?? 0;
        if (!first && now - last < COOLDOWN) continue;
        const result = evaluateChain(chain, ctx, first);
        if (!result.fired) continue;
        lastFiredRef.current[chain.id] = now;
        for (const action of result.actions) {
          applyAction(action, (next) => {
            runThemeTransition(() => setThemePreference(next));
          });
        }
      }
    };

    const run = (event: LogicEvent) => {
      const first = firstRef.current;
      firstRef.current = false;
      runChains(event, first);
    };

    // 页面载入求值一次。
    run({ kind: 'load' });

    const cleanups: (() => void)[] = [];

    if (needs.scroll) {
      let ticking = false;
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          ticking = false;
          const height = document.documentElement.scrollHeight - window.innerHeight;
          scrollRef.current = height > 0 ? Math.min(1, window.scrollY / height) : 0;
          run({ kind: 'scroll' });
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener('scroll', onScroll));
    }

    if (needs.idle) {
      const tick = window.setInterval(() => {
        idleRef.current += 1000;
        run({ kind: 'idle' });
      }, 1000);
      const onInteract = () => {
        idleRef.current = 0;
      };
      window.addEventListener('pointerdown', onInteract, { passive: true });
      window.addEventListener('keydown', onInteract, { passive: true });
      window.addEventListener('wheel', onInteract, { passive: true });
      cleanups.push(() => {
        window.clearInterval(tick);
        window.removeEventListener('pointerdown', onInteract);
        window.removeEventListener('keydown', onInteract);
        window.removeEventListener('wheel', onInteract);
      });
    }

    if (needs.pointer) {
      const findBlock = (target: EventTarget | null): string | undefined => {
        if (!(target instanceof Element)) return undefined;
        return target.closest('[data-pp-block]')?.getAttribute('data-pp-block') ?? undefined;
      };
      const onClick = (event: MouseEvent) => run({ kind: 'click', blockId: findBlock(event.target) });
      const onOver = (event: MouseEvent) => run({ kind: 'hover', blockId: findBlock(event.target) });
      document.addEventListener('click', onClick);
      document.addEventListener('mouseover', onOver, { passive: true });
      cleanups.push(() => {
        document.removeEventListener('click', onClick);
        document.removeEventListener('mouseover', onOver);
      });
    }

    return () => cleanups.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, needs.scroll, needs.idle, needs.pointer]);

  // 明暗切换求值：模式变化来自配置更新，单独监听。
  useEffect(() => {
    if (!needs.dark || !chains.length) return;
    const state = latest.current;
    const ctx: LogicContext = {
      pathname: state.pathname,
      isMobile: window.innerWidth < BREAKPOINT_MD,
      loggedIn: state.loggedIn,
      personal: state.personal,
      mode: state.mode,
      scroll: scrollRef.current,
      idleFor: idleRef.current,
      event: { kind: 'dark' },
    };
    for (const chain of state.chains) {
      if (!chain.enabled) continue;
      const result = evaluateChain(chain, ctx, false);
      if (!result.fired) continue;
      for (const action of result.actions) {
        applyAction(action, (next) => {
          runThemeTransition(() => setThemePreference(next));
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, needs.dark, chains.length]);

  return null;
}
