import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** 一张横向概览里的小卡片。文案由调用方翻译好再传进来。 */
export interface EffectCardItem {
  icon: IconName;
  label: string;
  value: ReactNode;
  note?: string;
}

/**
 * 横向概览卡组。
 *
 * 用于「性能优化 → 当前效果」与「人机验证 → 当前状态」：整块占满内容宽度，
 * 内部按可用宽度自动排成若干张小卡片，窄屏自动堆叠。
 */
export function EffectCards({
  items,
  columns,
}: {
  items: EffectCardItem[];
  /** 宽屏下的固定列数；窄屏仍会自动堆叠。 */
  columns?: 4 | 5;
}) {
  return (
    <div
      className={
        columns ? `effect-cards effect-cards-${columns}` : 'effect-cards'
      }
    >
      {items.map((item) => (
        <div className="effect-card" key={item.label}>
          <div className="effect-card-head">
            <span className="effect-card-icon">
              <Icon name={item.icon} size={14} />
            </span>
            <span>{item.label}</span>
          </div>
          <strong className="effect-card-value">{item.value}</strong>
          {item.note ? <span className="effect-card-note">{item.note}</span> : null}
        </div>
      ))}
    </div>
  );
}
