import type { ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
import { isExternalUrl, safeUrl } from '../../lib/safeUrl';
import { useT } from '../../lib/i18n';

/**
 * 页面编排器的行动按钮区块。
 *
 * 一个区块最多四颗按钮，横向排成一行：对齐与尺寸是区块级属性，每颗按钮的
 * 样式是条目级属性。链接在渲染前过一遍 `safeUrl()`，只放行 http(s) 与站内
 * 绝对路径；过滤后没有链接的按钮降级成不可点击的占位（保留样式，不响应点击）。
 *
 * 外链是否新窗口打开由 `new_tab` 决定，站内跳转始终留在当前标签页；新窗口
 * 一律带 `rel="noreferrer noopener"`，防止目标页拿到 window.opener。
 */

const ALIGNS = ['left', 'center', 'right'] as const;
const SIZES = ['sm', 'md', 'lg'] as const;
const STYLES = ['solid', 'outline', 'ghost', 'link'] as const;

type Align = (typeof ALIGNS)[number];
type Size = (typeof SIZES)[number];
type BtnStyle = (typeof STYLES)[number];

/** 取白名单里的值；坏的/旧的手写值退回默认档位，不改变排版基调。 */
function pick<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function ButtonBlock({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  // 面板限 4 个；旧配置可能超编，渲染时再截断一次。
  const items = blockPropRecord(block, 'buttons').slice(0, 4);
  const align = pick<Align>(blockProp<string>(block, 'align', 'left'), ALIGNS, 'left');
  const size = pick<Size>(blockProp<string>(block, 'size', 'md'), SIZES, 'md');
  const newTab = blockProp(block, 'new_tab', false);

  if (!items.length) {
    return <div className="pp-media-empty">{t('在右侧添加按钮后显示。')}</div>;
  }

  return (
    <div className={`pp-action-buttons pp-action-${align}`}>
      {items.map((item, index) => {
        const label = String(item.label ?? '').trim() || t('按钮');
        const link = safeUrl(item.link);
        const style = pick<BtnStyle>(String(item.style ?? ''), STYLES, 'solid');
        const className = `pp-action-btn is-${style} is-${size}`;
        if (!link) {
          // 没填链接：只留样式占位，明确不可点击。
          return (
            <span key={index} className={className} aria-disabled="true">
              {label}
            </span>
          );
        }
        const external = isExternalUrl(link) && newTab;
        return (
          <a
            key={index}
            className={className}
            href={link}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer noopener' : undefined}
          >
            {label}
          </a>
        );
      })}
    </div>
  );
}

export const ACTION_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  button: ButtonBlock,
};
