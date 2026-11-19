/**
 * 管理后台的界面字号。
 *
 * 后台是站长每天工作的地方，字号属于这台设备的偏好而不是站点设计：它保存在
 * 安装配置（`pp.web.config.v1`）里，不写进站点设计文档，也不影响访客看到的页面。
 * 安装向导会写一个初始值，之后即使换设备也是各自设备各自的大小。
 *
 * 取值范围与安装向导的滑杆保持一致：80%–120%。低于 0.8 的输入框、徽标会挤在一起，
 * 高于 1.2 的侧栏在 1366×768 的笔记本上会吃掉太多正文宽度。
 */

export const ADMIN_FONT_SCALE_MIN = 0.8;
export const ADMIN_FONT_SCALE_MAX = 1.2;
export const ADMIN_FONT_SCALE_STEP = 0.05;
export const DEFAULT_ADMIN_FONT_SCALE = 1;

/** 把任意来源的值收敛到合法倍率；非法值回退为默认 100%。 */
export function normalizeAdminFontScale(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_ADMIN_FONT_SCALE;
  const clamped = Math.min(ADMIN_FONT_SCALE_MAX, Math.max(ADMIN_FONT_SCALE_MIN, numeric));
  // 滑杆是 5% 一档；四舍五入到最近一档，再收掉浮点尾巴，避免出现 103.7000000001%
  // 或把 1.15 存成 1.1500000000000001 这种值。
  const stepped = Math.round(clamped / ADMIN_FONT_SCALE_STEP) * ADMIN_FONT_SCALE_STEP;
  return Number(stepped.toFixed(2));
}

/** 界面上的百分比写法：100%、105%……不显示多余小数。 */
export function adminFontPercent(scale: number): number {
  return Math.round(normalizeAdminFontScale(scale) * 100);
}
