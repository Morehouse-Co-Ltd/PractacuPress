import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
import { isExternalUrl, safeUrl } from '../../lib/safeUrl';
import { useT } from '../../lib/i18n';

/**
 * P2 媒体组件三件套：团队 / Logo 墙 / 图集。
 *
 * 三条定义都在 `lib/blocks.ts` 里，这里只负责画：
 * - 列数走一个 CSS 变量（`--pp-media-columns`），比例走另一个（`--pp-gallery-ratio`），
 *   窄屏怎么退化交给 `styles.css` 的断点表，不在组件里算；
 * - 图片地址一律过 `safeUrl()`：`javascript:`、协议相对地址之类到不了 `src`；
 * - 每张 `<img>` 都写 `alt`，装饰图（团队头像、Logo 的缺省）写空串而不是省掉属性——
 *   省掉会让读屏念出文件名；
 * - 没填图的条目直接跳过：空白格子比「少一张图」更让人困惑，团队头像则退回姓名首字母。
 *
 * 图集比前两件多一个状态机。为了能单测，下标计算抽成纯函数 `lightboxStep`，
 * DOM 那边只负责把状态喂给它；灯箱用原生 `<dialog>`（`showModal`），
 * Esc、焦点陷阱、`::backdrop` 都是浏览器给的，不引第三方库。
 */

/** 面板上的条数上限；与 `lib/blocks.ts` 的 `maxItems` 是同一组数字。 */
const MAX_TEAM = 12;
const MAX_LOGOS = 12;
const MAX_PHOTOS = 20;

/**
 * 灯箱的下标计算。
 *
 * 两端回绕：最后一张的下一张是第一张，第一张的上一张是最后一张。负数的取模在
 * JS 里是负值，所以统一 `(n % total + total) % total` 收正。坏输入收敛回合法下标：
 * 空集 / 单张永远停在 0，`total` 与 `current` 不是有限数时按 0 处理。
 */
export function lightboxStep(current: number, delta: number, total: number): number {
  const count = Number.isFinite(total) ? Math.trunc(total) : 0;
  if (count <= 1) return 0;
  const from = Number.isFinite(current) ? Math.trunc(current) : 0;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (((from + step) % count) + count) % count;
}

/** 列数：夹在面板给的范围内，非数字回落到该区块的默认列数。 */
function columnsOf(block: BlockInstance, fallback: number, min = 2, max = 4): number {
  const raw = Number(block.props.columns);
  const n = Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(max, Math.max(min, n));
}

function headingOf(block: BlockInstance): string {
  return blockProp(block, 'heading', '').trim();
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 姓名首字母：按码点取第一个字符，中文取第一个字；拉丁字母转大写。 */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? '';
  return first.toUpperCase();
}

/** 三个区块共用的外壳：标题行 + 内容，列数由各自的栅格通过 CSS 变量下发。 */
function MediaBlock({
  heading,
  children,
}: {
  heading: string;
  children: ReactElement;
}) {
  return (
    <div className="pp-mediablock">
      {heading ? <h2 className="pp-mediablock-heading">{heading}</h2> : null}
      {children}
    </div>
  );
}

function EmptyItems() {
  const t = useT();
  return <div className="pp-media-empty">{t('在右侧添加条目。')}</div>;
}

/** 站内链接不加 `target`，外链另开窗口并带上 `noopener`。 */
function linkAttrs(url: string): { target?: string; rel?: string } {
  return isExternalUrl(url) ? { target: '_blank', rel: 'noreferrer noopener' } : {};
}

function Team({ block }: { block: BlockInstance }): ReactElement {
  const items = blockPropRecord(block, 'items').slice(0, MAX_TEAM);
  return (
    <MediaBlock heading={headingOf(block)}>
      {items.length ? (
        <ul
          className="pp-team"
          style={{ '--pp-media-columns': columnsOf(block, 3) } as CSSProperties}
        >
          {items.map((item, index) => {
            const avatar = safeUrl(item.avatar);
            const name = textOf(item.name);
            const role = textOf(item.role);
            const link = safeUrl(item.link);
            const card = (
              <>
                <span className="pp-team-avatar">
                  {avatar ? (
                    // 姓名就在头像下面，图片本身是装饰：alt 空串，读屏不会重复念一遍。
                    <img src={avatar} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <span className="pp-team-initial" aria-hidden>
                      {initialOf(name)}
                    </span>
                  )}
                </span>
                {name ? <span className="pp-team-name">{name}</span> : null}
                {role ? <span className="pp-team-role">{role}</span> : null}
              </>
            );
            return (
              <li className="pp-team-member" key={index}>
                {link ? (
                  <a className="pp-team-link" href={link} {...linkAttrs(link)}>
                    {card}
                  </a>
                ) : (
                  <div className="pp-team-card">{card}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyItems />
      )}
    </MediaBlock>
  );
}

function LogoWall({ block }: { block: BlockInstance }): ReactElement {
  const items = blockPropRecord(block, 'items').slice(0, MAX_LOGOS);
  // 没有可用图片的条目直接跳过：Logo 墙里一格空白比少一个 Logo 更刺眼。
  const logos = items
    .map((item) => ({
      src: safeUrl(item.image),
      link: safeUrl(item.link),
      alt: textOf(item.alt),
    }))
    .filter((logo) => logo.src);
  return (
    <MediaBlock heading={headingOf(block)}>
      {logos.length ? (
        <ul
          className="pp-logo-wall"
          style={{ '--pp-media-columns': columnsOf(block, 4, 2, 6) } as CSSProperties}
        >
          {logos.map((logo, index) => (
            <li className="pp-logo-wall-item" key={index}>
              {logo.link ? (
                <a href={logo.link} {...linkAttrs(logo.link)}>
                  <img src={logo.src} alt={logo.alt} loading="lazy" decoding="async" />
                </a>
              ) : (
                <img src={logo.src} alt={logo.alt} loading="lazy" decoding="async" />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyItems />
      )}
    </MediaBlock>
  );
}

function Gallery({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const rawRatio = blockProp(block, 'ratio', '4:3');
  const ratio = ['1:1', '4:3', '16:9'].includes(rawRatio) ? rawRatio : '4:3';
  const items = blockPropRecord(block, 'items').slice(0, MAX_PHOTOS);
  // 只有能显示的图片才算一张：说明文字留着当 alt / 大图下方的小字。
  const photos = items
    .map((item) => ({ src: safeUrl(item.image), caption: textOf(item.caption) }))
    .filter((photo) => photo.src);

  const [index, setIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const thumbsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // 关闭后焦点回到「被点的那张」，而不是回到第一张。
  const restoreRef = useRef(0);
  // 条目可能在灯箱开着时被作者删掉：越界的下标一律当作「已关闭」，
  // 免得留下一张空白大图。
  const openIndex = index !== null && index >= 0 && index < photos.length ? index : null;
  const active = openIndex === null ? null : photos[openIndex];

  const open = (next: number) => {
    restoreRef.current = next;
    setIndex(next);
  };

  const close = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      // `close()` 会派发 close 事件，状态与焦点在监听里统一收尾。
      dialog.close();
      return;
    }
    setIndex(null);
  };

  const step = (delta: number) => {
    setIndex((current) => (current === null ? current : lightboxStep(current, delta, photos.length)));
  };

  // 状态是唯一真相：dialog.open 跟着它走，Esc / 关闭按钮 / 切换都只改状态。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (openIndex === null) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
  }, [openIndex]);

  // 关闭后把焦点还给缩略图：dialog 关闭时浏览器会把它扔回 <body>，
  // 键盘用户必须回到原来的位置。Esc 在浏览器里发 cancel，自己没有原生关闭
  // 事件的环境（测试用的 happy-dom）只发 cancel，所以两个事件都收。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const settle = () => {
      setIndex(null);
      thumbsRef.current[restoreRef.current]?.focus();
    };
    dialog.addEventListener('close', settle);
    dialog.addEventListener('cancel', settle);
    return () => {
      dialog.removeEventListener('close', settle);
      dialog.removeEventListener('cancel', settle);
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (photos.length < 2) return;
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    step(delta);
  };

  return (
    <MediaBlock heading={headingOf(block)}>
      {photos.length ? (
        <>
          <div
            className="pp-gallery-grid"
            data-ratio={ratio}
            style={
              {
                '--pp-media-columns': columnsOf(block, 3),
                // `4:3` 是数据里的写法，CSS 的 aspect-ratio 要 `4 / 3`。
                '--pp-gallery-ratio': ratio.replace(':', ' / '),
              } as CSSProperties
            }
          >
            {photos.map((photo, photoIndex) => (
              <button
                type="button"
                className="pp-gallery-thumb"
                key={`${photo.src}-${photoIndex}`}
                ref={(node) => {
                  thumbsRef.current[photoIndex] = node;
                }}
                onClick={() => open(photoIndex)}
                aria-label={
                  photo.caption
                    ? t('查看大图：{caption}', { caption: photo.caption })
                    : t('查看大图')
                }
              >
                <img src={photo.src} alt={photo.caption} loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
          <dialog
            ref={dialogRef}
            className="pp-gallery-dialog"
            aria-label={t('大图预览')}
            onKeyDown={onKeyDown}
          >
            {active ? (
              <figure className="pp-gallery-figure">
                <img
                  className="pp-gallery-large"
                  src={active.src}
                  alt={active.caption}
                  decoding="async"
                />
                {active.caption ? (
                  <figcaption className="pp-gallery-caption">{active.caption}</figcaption>
                ) : null}
              </figure>
            ) : null}
            <div className="pp-gallery-bar">
              {photos.length > 1 ? (
                <button
                  type="button"
                  className="pp-gallery-prev"
                  onClick={() => step(-1)}
                  aria-label={t('上一张')}
                >
                  ‹
                </button>
              ) : null}
              <span className="pp-gallery-count">
                {t('第 {count} 张 / 共 {total} 张', {
                  count: (openIndex ?? 0) + 1,
                  total: photos.length,
                })}
              </span>
              {photos.length > 1 ? (
                <button
                  type="button"
                  className="pp-gallery-next"
                  onClick={() => step(1)}
                  aria-label={t('下一张')}
                >
                  ›
                </button>
              ) : null}
              <button
                type="button"
                className="pp-gallery-close"
                onClick={close}
                aria-label={t('关闭预览')}
              >
                ×
              </button>
            </div>
          </dialog>
        </>
      ) : (
        <EmptyItems />
      )}
    </MediaBlock>
  );
}

export const MEDIA_GALLERY_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  team: Team,
  'logo-wall': LogoWall,
  gallery: Gallery,
};
