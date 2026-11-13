import { flushSync } from 'react-dom';
import { motionReduced } from './performance';

/**
 * 明暗切换时的颜色过渡。
 *
 * 主题令牌是 CSS 变量，切换本身是瞬时的；给所有会变色的元素挂一段短的
 * `background-color / color / border-color` 过渡，就能把生硬的反色变成
 * 一次呼吸。只在切换的这几百毫秒里打开，不常驻，避免拖慢滚动与悬停。
 */
const CLASS = 'pp-theme-tween';
const DURATION_MS = 420;
let timer = 0;

export function runThemeTransition(apply: () => void): void {
  if (typeof document === 'undefined') {
    apply();
    return;
  }
  if (motionReduced()) {
    apply();
    return;
  }
  const root = document.documentElement;
  window.clearTimeout(timer);
  root.classList.add(CLASS);
  apply();
  timer = window.setTimeout(() => {
    root.classList.remove(CLASS);
  }, DURATION_MS);
}

/**
 * 用浏览器原生的 View Transition 包住一次路由跳转。
 *
 * 登录完成时页面会从「站点外壳」切到「管理后台」，两边的底色可能一深一浅；
 * 直接换树会看起来像闪屏。View Transition 会把旧页面截图和新页面叠在一起
 * 交叉淡化，登录、退出、进出后台都因此平滑。不支持该 API 的浏览器直接跳转。
 */
export function navigateWithTransition(navigate: () => void): void {
  if (typeof document === 'undefined') {
    navigate();
    return;
  }
  if (typeof document.startViewTransition !== 'function' || motionReduced()) {
    navigate();
    return;
  }
  document.startViewTransition(() => {
    // React 19 的更新默认是并发的；在回调里同步刷一次，View Transition
    // 才能在新页面已经挂载之后取到正确的截图。
    flushSync(navigate);
  });
}

