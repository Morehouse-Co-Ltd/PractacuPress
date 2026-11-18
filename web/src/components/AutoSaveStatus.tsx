import { useT } from '../lib/i18n';

/** 自动保存的生命周期状态。 */
export type AutoSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * 设置页顶部的自动保存状态。
 *
 * 设置改成自动保存以后，「保存修改」按钮被移除，站长需要一个不打扰的落点确认
 * 改动真的写到了服务端：`role="status"` 让屏幕阅读器在状态变化时播报，
 * 视觉上只是一行小字，不会抢走表单的注意力。
 */
export function AutoSaveStatus({
  state,
  error,
  className = '',
  live = true,
}: {
  state: AutoSaveState;
  /** 状态为 error 时展示的原因；没有时回退到通用文案。 */
  error?: string;
  className?: string;
  /**
   * 同一个页面可能同时显示顶部和底部的状态条。只让其中一条成为 live region，
   * 否则屏幕阅读器会把每次自动保存播报两遍。
   */
  live?: boolean;
}) {
  const t = useT();
  const label =
    state === 'saving'
      ? t('正在自动保存…')
      : state === 'pending'
        ? t('修改会在停止输入后自动保存')
        : state === 'error'
          ? error || t('自动保存失败')
          : state === 'saved'
            ? t('已自动保存')
            : t('修改会自动保存');
  return (
    <span
      className={`autosave-status is-${state} tiny faint${className ? ` ${className}` : ''}`}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : 'off'}
      aria-atomic={live ? true : undefined}
    >
      <span className="autosave-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
