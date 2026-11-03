import type { ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
import { renderMarkdown, sanitizeHtml } from '../../lib/markdown';
import { isExternalUrl, safeUrl } from '../../lib/safeUrl';
import { useT } from '../../lib/i18n';

/**
 * P2 说服组件四件套：定价 / 常见问题 / 用户评价 / 图文交替。
 *
 * 四条定义都在 `lib/blocks.ts` 里，这里只负责画：
 * - 链接一律过 `safeUrl()`，外链另开窗口并带 `rel="noreferrer noopener"`（与 `button`
 *   区块同一套处理）；没过白名单的按钮降级成不可点的占位，而不是留一个空 href；
 * - 定价档位的功能清单是「一行一条」的自由文本，拆行规则抽成纯函数 `splitFeatures`，
 *   行首一个 `-` 表示"这一档不含"，渲染成灰色删除线；
 * - 常见问题用原生 `<details>` / `<summary>`：折叠、键盘可达、没有 JavaScript；
 * - 评价的横滑是 CSS `scroll-snap`，零 JS。纯 CSS 拿不到滚动位置，所以没做分页圆点
 *   （真要跟随高亮得引滚动监听，为一个装饰点不值得）；
 * - 图文交替的正文是 `richtext`，走 `renderMarkdown` + `sanitizeHtml`——与 `text`
 *   区块同一条链路，不另开一套渲染；
 * - 旧配置可能超出面板的条数上限，渲染时再截一次。
 */

/** 面板上的条数上限；与 `lib/blocks.ts` 的 `maxItems` 是同一组数字。 */
const MAX_PLANS = 4;
const MAX_FAQ = 20;
const MAX_QUOTES = 9;

/** 功能清单里的一条：`included: false` 表示"这一档不含"。 */
export interface PricingFeature {
  label: string;
  included: boolean;
}

/**
 * 把定价档位的功能清单拆成条目。
 *
 * 规则简单到可以在面板提示里用一句话讲清：一行一条，行首的 `-` 表示"不含"。
 * 边界情况的取舍：
 * - 空行、只有空白字符的行跳过——作者用空行分组时不希望在列表里留个空洞；
 * - 行首行尾的空白一律去掉，`- 深度报告 ` 与 `-深度报告` 等价；
 * - 重复的标签只保留第一次出现的那条：同一个功能写两遍是笔误，先写的（含"含"或
 *   "不含"）说了算，不去猜作者后一次是不是改主意了；
 * - 只剩一个 `-` 的行没有标签，直接丢掉，不生成一条空的删除线。
 */
export function splitFeatures(text: string): PricingFeature[] {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set<string>();
  const out: PricingFeature[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const included = !line.startsWith('-');
    // 标记只吃掉一个 `-`：`--x` 剩下的 `-x` 仍然是标签的一部分。
    const label = (included ? line : line.slice(1)).trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, included });
  }
  return out;
}

function headingOf(block: BlockInstance): string {
  return blockProp(block, 'heading', '').trim();
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 站内链接不加 `target`，外链另开窗口并带上 `noopener`。 */
function linkAttrs(url: string): { target?: string; rel?: string } {
  return isExternalUrl(url) ? { target: '_blank', rel: 'noreferrer noopener' } : {};
}

/** 三个区块共用的外壳：标题行 + 内容。 */
function ConversionBlock({
  heading,
  children,
}: {
  heading: string;
  children: ReactElement;
}) {
  return (
    <div className="pp-conversion">
      {heading ? <h2 className="pp-conversion-heading">{heading}</h2> : null}
      {children}
    </div>
  );
}

function EmptyItems() {
  const t = useT();
  return <div className="pp-media-empty">{t('在右侧添加条目。')}</div>;
}

/**
 * 行动按钮：能过白名单就是真链接，过不了就退化成不可点的占位。
 *
 * 占位保留按钮样式但用 `<span aria-disabled>` 而不是 `<a href="#">`——后者会让
 * 键盘用户 Tab 到一个点了没反应、还改变地址栏的东西。
 */
function Cta({ className, label, link }: { className: string; label: string; link: string }) {
  const url = safeUrl(link);
  if (!url) {
    return (
      <span className={className} aria-disabled="true">
        {label}
      </span>
    );
  }
  return (
    <a className={className} href={url} {...linkAttrs(url)}>
      {label}
    </a>
  );
}

function Pricing({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const items = blockPropRecord(block, 'items').slice(0, MAX_PLANS);
  return (
    <ConversionBlock heading={headingOf(block)}>
      {items.length ? (
        <div className="pp-pricing">
          {items.map((item, index) => {
            const features = splitFeatures(textOf(item.features));
            const price = textOf(item.price);
            const period = textOf(item.period);
            const label = textOf(item.cta_label);
            // 只有真正的 true 才算推荐档：旧配置里的 'true' 字符串不该高亮。
            const featured = item.featured === true;
            return (
              <article
                className={`pp-pricing-plan${featured ? ' is-featured' : ''}`}
                key={index}
              >
                {featured ? <span className="pp-pricing-badge">{t('推荐')}</span> : null}
                {textOf(item.name) ? (
                  <h3 className="pp-pricing-name">{textOf(item.name)}</h3>
                ) : null}
                {price || period ? (
                  <p className="pp-pricing-amount">
                    {price ? <span className="pp-pricing-price">{price}</span> : null}
                    {period ? <span className="pp-pricing-period">{period}</span> : null}
                  </p>
                ) : null}
                {features.length ? (
                  <ul className="pp-pricing-features">
                    {features.map((feature, featureIndex) => (
                      <li
                        className={`pp-pricing-feature${feature.included ? '' : ' is-excluded'}`}
                        key={featureIndex}
                      >
                        {feature.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {label ? (
                  <Cta className="pp-pricing-cta" label={label} link={textOf(item.cta_link)} />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyItems />
      )}
    </ConversionBlock>
  );
}

function Faq({ block }: { block: BlockInstance }): ReactElement {
  // 面板限 20 条；旧配置可能超编，渲染时再截一次。
  const openFirst = blockProp(block, 'open_first', false);
  // 没写问题的条目跳过：折叠标题是空的，展开也没人知道那是什么。
  const items = blockPropRecord(block, 'items')
    .slice(0, MAX_FAQ)
    .filter((item) => textOf(item.question));
  return (
    <ConversionBlock heading={headingOf(block)}>
      {items.length ? (
        <div className="pp-faq">
          {items.map((item, index) => (
            // `open` 只在第一条上按开关决定；其余条目交给浏览器自己的展开状态。
            <details className="pp-faq-item" key={index} open={index === 0 ? openFirst : undefined}>
              <summary className="pp-faq-question">{textOf(item.question)}</summary>
              {textOf(item.answer) ? (
                <p className="pp-faq-answer">{textOf(item.answer)}</p>
              ) : null}
            </details>
          ))}
        </div>
      ) : (
        <EmptyItems />
      )}
    </ConversionBlock>
  );
}

function Testimonial({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const heading = headingOf(block);
  // 坏值（旧配置的手写值）退回栅格：那是两者的共同下限，不会把版面撑破。
  const carousel = blockProp<string>(block, 'layout', 'grid') === 'carousel';
  const items = blockPropRecord(block, 'items')
    .slice(0, MAX_QUOTES)
    .filter((item) => textOf(item.quote));
  return (
    <ConversionBlock heading={heading}>
      {items.length ? (
        <div
          className={`pp-testimonial is-${carousel ? 'carousel' : 'grid'}`}
          {...(carousel
            ? // 原生滚动容器要能聚焦，键盘用户才能用方向键翻看。
              { tabIndex: 0, role: 'group', 'aria-label': heading || t('用户评价') }
            : {})}
        >
          {items.map((item, index) => {
            const avatar = safeUrl(item.avatar);
            const name = textOf(item.name);
            const role = textOf(item.role);
            return (
              <figure className="pp-testimonial-card" key={index}>
                <blockquote className="pp-testimonial-quote">{textOf(item.quote)}</blockquote>
                <figcaption className="pp-testimonial-person">
                  {avatar ? (
                    // 姓名就在头像旁边，头像本身是装饰：alt 空串，读屏不重复念一遍。
                    <img
                      className="pp-testimonial-avatar"
                      src={avatar}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                  {name ? <span className="pp-testimonial-name">{name}</span> : null}
                  {role ? <span className="pp-testimonial-role">{role}</span> : null}
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <EmptyItems />
      )}
    </ConversionBlock>
  );
}

function MediaText({ block }: { block: BlockInstance }): ReactElement | null {
  const image = safeUrl(blockProp(block, 'image', ''));
  const alt = blockProp(block, 'alt', '').trim();
  const title = blockProp(block, 'title', '').trim();
  const body = blockProp<string>(block, 'body', '');
  // 只有显式的 right 才翻面；其余（含旧配置的空值）都是图在左。
  const right = blockProp<string>(block, 'side', 'left') === 'right';
  const ctaLabel = blockProp(block, 'cta_label', '').trim();
  const ctaLink = blockProp(block, 'cta_link', '');
  // 四样都空时不画一个空壳：与 `text` 区块一样，空区块不占版面。
  if (!image && !title && !body && !ctaLabel) return null;
  return (
    <div className={`pp-media-text${right ? ' is-right' : ''}`}>
      {image ? (
        <figure className="pp-media-text-figure">
          <img src={image} alt={alt} loading="lazy" decoding="async" />
        </figure>
      ) : null}
      <div className="pp-media-text-copy">
        {title ? <h2 className="pp-media-text-title">{title}</h2> : null}
        {body ? (
          <div
            className="pp-media-text-body article-body"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(body)) }}
          />
        ) : null}
        {ctaLabel ? (
          <Cta className="pp-media-text-cta" label={ctaLabel} link={ctaLink} />
        ) : null}
      </div>
    </div>
  );
}

export const CONVERSION_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  pricing: Pricing,
  faq: Faq,
  testimonial: Testimonial,
  'media-text': MediaText,
};
