import type { CSSProperties, ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
import { navIconName } from '../../lib/navigation';
import { isExternalUrl, safeUrl } from '../../lib/safeUrl';
import { useT } from '../../lib/i18n';
import { Icon } from '../Icon';

/**
 * P2 无媒体组件三件套：功能网格 / 卡片组 / 步骤。
 *
 * 三条定义都在 `lib/blocks.ts` 里，这里只负责画：列数走一个 CSS 变量
 * （`--pp-marketing-columns`），窄屏行为交给 `styles.css` 的断点表，不在组件里算。
 *
 * 共同的取舍：
 * - 条目为空时给作者一句「在右侧添加条目。」——空白画布看不出是没配好还是本来就空；
 * - 图标只认内置图标集（`navIconName`），配置里写了别的名字就静默不画，不出现方框；
 * - 链接一律过 `safeUrl()`，过滤掉 `javascript:` 之类；卡片没填链接就退化成静态卡；
 * - 旧配置可能超出面板的条数上限，渲染时再截一次。
 */

/** 面板上的条数上限；与 `lib/blocks.ts` 的 `maxItems` 是同一组数字。 */
const MAX_ITEMS = 8;
const MAX_CARDS = 9;

/** 列数：夹在 2–4，非数字回落到 3（与 defaults 一致）。 */
function columnsOf(block: BlockInstance): number {
  const raw = Number(block.props.columns);
  const n = Number.isFinite(raw) ? Math.round(raw) : 3;
  return Math.min(4, Math.max(2, n));
}

function headingOf(block: BlockInstance): string {
  return blockProp(block, 'heading', '').trim();
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 三个区块共用的外壳：标题行 + 内容，列数通过 CSS 变量下发给栅格。 */
function MarketingBlock({
  heading,
  columns,
  children,
}: {
  heading: string;
  columns?: number;
  children: ReactElement;
}) {
  return (
    <div
      className="pp-marketing"
      style={columns ? ({ '--pp-marketing-columns': columns } as CSSProperties) : undefined}
    >
      {heading ? <h2 className="pp-marketing-heading">{heading}</h2> : null}
      {children}
    </div>
  );
}

function EmptyItems() {
  const t = useT();
  return <div className="pp-media-empty">{t('在右侧添加条目。')}</div>;
}

function FeatureGrid({ block }: { block: BlockInstance }): ReactElement {
  const columnCount = columnsOf(block);
  const items = blockPropRecord(block, 'items').slice(0, MAX_ITEMS);
  return (
    <MarketingBlock heading={headingOf(block)} columns={columnCount}>
      {items.length ? (
        <div className="pp-feature-grid">
          {items.map((item, index) => {
            const icon = navIconName(item.icon);
            const title = textOf(item.title);
            const text = textOf(item.text);
            return (
              <article className="pp-feature-card" key={index}>
                {icon ? (
                  <span className="pp-feature-icon" aria-hidden>
                    <Icon name={icon} size={20} />
                  </span>
                ) : null}
                {title ? <h3 className="pp-feature-title">{title}</h3> : null}
                {text ? <p className="pp-feature-text">{text}</p> : null}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyItems />
      )}
    </MarketingBlock>
  );
}

function CardGrid({ block }: { block: BlockInstance }): ReactElement {
  const columnCount = columnsOf(block);
  const items = blockPropRecord(block, 'items').slice(0, MAX_CARDS);
  return (
    <MarketingBlock heading={headingOf(block)} columns={columnCount}>
      {items.length ? (
        <div className="pp-card-grid">
          {items.map((item, index) => {
            const title = textOf(item.title);
            const text = textOf(item.text);
            const link = safeUrl(item.link);
            const external = link ? isExternalUrl(link) : false;
            const body = (
              <>
                {title ? <h3 className="pp-card-grid-title">{title}</h3> : null}
                {text ? <p className="pp-card-grid-text">{text}</p> : null}
              </>
            );
            // 没填链接（或链接没过白名单）：静态卡，不上 href，不留可点的假象。
            return link ? (
              <a
                className="pp-card-grid-card is-link"
                href={link}
                key={index}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer noopener' : undefined}
              >
                {body}
              </a>
            ) : (
              <div className="pp-card-grid-card" key={index}>
                {body}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyItems />
      )}
    </MarketingBlock>
  );
}

function Steps({ block }: { block: BlockInstance }): ReactElement {
  const horizontal = blockProp<string>(block, 'orientation', 'vertical') === 'horizontal';
  const items = blockPropRecord(block, 'items').slice(0, MAX_ITEMS);
  return (
    <MarketingBlock heading={headingOf(block)}>
      {items.length ? (
        // 有序列表承载「第几步」的语义；圈里的数字只是视觉重复，对读屏隐藏。
        <ol className={`pp-steps${horizontal ? ' is-horizontal' : ''}`}>
          {items.map((item, index) => {
            const title = textOf(item.title);
            const text = textOf(item.text);
            return (
              <li className="pp-step" key={index}>
                <span className="pp-step-no" aria-hidden>
                  {index + 1}
                </span>
                <div className="pp-step-body">
                  {title ? <h3 className="pp-step-title">{title}</h3> : null}
                  {text ? <p className="pp-step-text">{text}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyItems />
      )}
    </MarketingBlock>
  );
}

export const MARKETING_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  'feature-grid': FeatureGrid,
  'card-grid': CardGrid,
  steps: Steps,
};
