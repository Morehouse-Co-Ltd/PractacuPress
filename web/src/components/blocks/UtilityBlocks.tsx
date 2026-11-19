import { useEffect, useState, type ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
import { safeUrl } from '../../lib/safeUrl';
import { useT } from '../../lib/i18n';

/**
 * P2 工具型区块三件套：对比表 / 倒计时 / 音频。
 *
 * 三条定义都在 `lib/blocks.ts` 里，这里只负责画。三条硬规则：
 * - **对比表**是真的 `<table>`：列头 `scope="col"`、行头 `scope="row"`，读屏能念出
 *   「哪一个功能，在左 / 右哪边是什么」。窄屏不折叠、不改成卡片——横向滚动一个
 *   带 `role="region"` 的容器，键盘能用方向键看完，版面也不会挤成一列散文；
 * - **倒计时**每秒重算一次，`setInterval(1000)` 在卸载与目标变化时清理。为了首帧
 *   不闪 `NaN`，时间点的初始状态是 `null`（画 `--` 占位），定时器在 effect 里才
 *   写入第一帧真实值。日期只认 `YYYY-MM-DD`（作者本地零点）与完整 ISO 时间；
 *   认不出来就按「已结束」处理，不猜、不崩；
 * - **音频**用原生 `<audio controls preload="metadata">`，**不自动播放**：一个页面
 *   里出现声音是访客的选择，不是作者的。`src` / `cover` 都是用户填的地址，先过
 *   `safeUrl`；地址不过白名单就当没填，不留一个点了没反应的播放器。
 *
 * 旧配置可能超出面板的条数上限，渲染时再截一次。
 */

/** 面板上的行数上限；与 `lib/blocks.ts` 的 `maxItems` 是同一个数字。 */
const MAX_ROWS = 12;

/** 日期文本：只认 `YYYY-MM-DD` 与「日期 + 时间」的 ISO 形式。 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}/;

/**
 * 解析倒计时的目标时间。
 *
 * 两档，别的一律不认：
 * - `YYYY-MM-DD`：按**作者本地零点**解析。`new Date('2026-12-31')` 按规范是 UTC
 *   零点，那会让东八区的作者发现自己写的 12-31 早八点就结束了；
 * - `YYYY-MM-DDThh:mm…`（也放行空格分隔）：交给 `Date` 处理时区与毫秒。
 *
 * 「认不出来」包括不存在的日期（`2026-02-31`）：`new Date(y, m, d)` 会静默滚到
 * 下个月，所以回读年月日核对，滚过就返回 `null`。宁可不显示，也不显示一个错的日期。
 */
export function parseTargetDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }
  // 只放行长成 ISO 的「日期 + 时间」：`tomorrow`、`12/31/2026`、`2026-1-1` 这些
  // 各引擎解释不一的写法一律不当成日期。
  if (!DATE_TIME.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 剩余时间的四段；已结束（含 `NaN`）返回 `null`。 */
export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * 把剩余毫秒拆成天 / 小时 / 分 / 秒。
 *
 * 不足一秒向下取整：倒计时显示的是「还剩多少整秒」，向上取整会在到点时显示
 * `00:00:00:01` 卡住一秒。
 */
export function countdownParts(ms: number): CountdownParts | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function EmptyItems() {
  const t = useT();
  return <div className="pp-media-empty">{t('在右侧添加条目。')}</div>;
}

/**
 * 对比表。
 *
 * 结构就是「一个行标题列 + 两个对比列」。左上角那格没有文案，用一个 `sr-only`
 * 的「项目」给读屏一个名字——空 `<th>` 会让读屏念出「空白」，读者不知道那一列是什么。
 * 表头行只在填了左 / 右表头时画：两个都是空的时候，一排空标题比没有更糟。
 */
function Comparison({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const heading = textOf(blockProp(block, 'heading', ''));
  const leftLabel = textOf(blockProp(block, 'left_label', ''));
  const rightLabel = textOf(blockProp(block, 'right_label', ''));
  const hasHead = !!(leftLabel || rightLabel);
  const rows = blockPropRecord(block, 'rows')
    .slice(0, MAX_ROWS)
    .filter((row) => textOf(row.label) || textOf(row.left) || textOf(row.right));
  return (
    <div className="pp-comparison">
      {heading ? <h2 className="pp-comparison-heading">{heading}</h2> : null}
      {rows.length ? (
        // 窄屏把表格留在原地横滑：折叠成卡片会丢掉「左右两列」的对位关系，
        // 而对比表的价值就在对位。容器可聚焦，键盘用户才能用方向键看完。
        <div
          className="pp-comparison-scroll"
          role="region"
          tabIndex={0}
          aria-label={heading || t('对比表')}
        >
          <table className="pp-comparison-table">
            {hasHead ? (
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t('项目')}</span>
                  </th>
                  <th scope="col">{leftLabel}</th>
                  <th scope="col">{rightLabel}</th>
                </tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <th scope="row">{textOf(row.label)}</th>
                  <td>{textOf(row.left)}</td>
                  <td>{textOf(row.right)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyItems />
      )}
    </div>
  );
}

/**
 * 倒计时。
 *
 * 时间点的状态是**数字**而不是 `Date`：`Date` 每次渲染都是新对象，放进 effect 的
 * 依赖数组会让「设置时间 → 重渲染 → 又是新对象」无限循环；毫秒数字天然稳定。
 */
function Countdown({ block }: { block: BlockInstance }): ReactElement | null {
  const t = useT();
  const title = textOf(blockProp(block, 'title', ''));
  const targetRaw = textOf(blockProp(block, 'target', ''));
  const expiredText = textOf(blockProp(block, 'expired_text', ''));
  // 只有显式的 false 才藏秒；旧配置缺这个键时按默认显示。
  const showSeconds = blockProp<boolean>(block, 'show_seconds', true) !== false;
  const targetMs = parseTargetDate(targetRaw)?.getTime() ?? null;
  // `null` = 还没量过（首帧）。占位而不是 0，否则会先闪一下 `NaN` 或满格。
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (targetMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [targetMs]);

  // 目标日期认不出来时也走「结束」这一支：作者至少能得到一句明确的文案。
  const expired = targetMs === null || (now !== null && targetMs - now <= 0);
  const parts = !expired && now !== null && targetMs !== null ? countdownParts(targetMs - now) : null;
  const units: { key: keyof CountdownParts; label: string }[] = [
    { key: 'days', label: t('天') },
    { key: 'hours', label: t('小时') },
    { key: 'minutes', label: t('分钟') },
    { key: 'seconds', label: t('秒') },
  ];

  // 三样都空：空区块不占版面（与 `text` / `media-text` 一致）。
  if (!title && !targetRaw && !expiredText) return null;

  return (
    <div className="pp-countdown">
      {title ? <h2 className="pp-countdown-title">{title}</h2> : null}
      {expired ? (
        <p className="pp-countdown-expired">{expiredText || t('已结束')}</p>
      ) : (
        // `role="timer"` 默认是 aria-live=off：每秒念一遍倒计时会把读屏淹掉。
        <div
          className="pp-countdown-clock"
          role="timer"
          aria-label={title || t('倒计时')}
        >
          {units
            .filter((unit) => showSeconds || unit.key !== 'seconds')
            .map((unit) => (
              <span className="pp-countdown-unit" key={unit.key}>
                <span className="pp-countdown-value">
                  {parts ? pad(parts[unit.key]) : '--'}
                </span>
                <span className="pp-countdown-label">{unit.label}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * 音频。
 *
 * 原生播放器：`preload="metadata"` 只取时长与封面信息，不下载整段音频；
 * **不写 `autoPlay`**——自动出声是最招人烦的一类网页行为。
 * 没有可播放的地址时整块不画：`<audio>` 没 `src` 只会得到一个灰掉的空播放器。
 */
function Audio({ block }: { block: BlockInstance }): ReactElement | null {
  const t = useT();
  const src = safeUrl(blockProp(block, 'src', ''));
  const cover = safeUrl(blockProp(block, 'cover', ''));
  const title = textOf(blockProp(block, 'title', ''));
  const artist = textOf(blockProp(block, 'artist', ''));
  if (!src) return null;
  return (
    <div className="pp-audio">
      {cover || title || artist ? (
        <div className="pp-audio-head">
          {cover ? (
            // 封面对读屏是装饰：标题与作者就在旁边，alt 空串避免念两遍。
            <img className="pp-audio-cover" src={cover} alt="" loading="lazy" decoding="async" />
          ) : null}
          <div className="pp-audio-meta">
            {title ? <span className="pp-audio-title">{title}</span> : null}
            {artist ? <span className="pp-audio-artist">{artist}</span> : null}
          </div>
        </div>
      ) : null}
      <audio
        className="pp-audio-player"
        controls
        preload="metadata"
        src={src}
        aria-label={title || t('音频')}
      />
    </div>
  );
}

export const UTILITY_RENDERERS: Record<
  string,
  (props: { block: BlockInstance }) => ReactElement | null
> = {
  comparison: Comparison,
  countdown: Countdown,
  audio: Audio,
};
