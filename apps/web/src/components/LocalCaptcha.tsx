import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import type {
  CaptchaScene,
  LocalCaptchaAnswer,
  LocalCaptchaChallenge,
  LocalCaptchaPoint,
} from '../types';
import { captchaCellIndex, captchaPointFromEvent } from '../lib/captcha';
import { useBackend } from '../lib/backend';
import { useT } from '../lib/i18n';
import { Button, Callout } from './ui';

/**
 * 本地（自托管）人机验证组件。
 *
 * 服务端轮换三种图形题，前端按 `kind` 渲染对应交互：
 *
 * - `slider`：拖动圆形拼图，对齐图中的缺口；
 * - `click`：点中图里所有星星，旁边混着方块、三角形等干扰图形；
 * - `select`：在九宫格里选出所有包含圆形的格子。
 *
 * 三种都只提交几何答案（像素坐标或格子序号），token 仍由本站接口按一次性规则发放，
 * 与第三方服务商 token 走同一条提交流程。所有坐标都按图片原始像素换算，窄屏下图片
 * 被 CSS 缩小时也不会点偏。
 */

export interface LocalCaptchaFieldProps {
  scene: CaptchaScene;
  /** 变更这个值会重新取题（提交失败后由表单递增）。 */
  resetKey: number;
  onToken: (token: string) => void;
  onFailure?: (message: string) => void;
}

export function LocalCaptchaField({
  scene,
  resetKey,
  onToken,
  onFailure,
}: LocalCaptchaFieldProps) {
  const t = useT();
  const backend = useBackend();
  const [challenge, setChallenge] = useState<LocalCaptchaChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [solved, setSolved] = useState(false);
  const [failure, setFailure] = useState('');
  /** 只接受最新一次取题请求的应答，避免「换一题」被旧响应覆盖。 */
  const generation = useRef(0);

  const report = useCallback(
    (message: string) => {
      setFailure(message);
      onFailure?.(message);
    },
    [onFailure],
  );

  const load = useCallback(() => {
    const request = backend.captchaLocalChallenge;
    if (!request) {
      const message = t('本站没有启用本地人机验证。');
      setLoading(false);
      report(message);
      return;
    }
    const run = ++generation.current;
    setLoading(true);
    setSolved(false);
    setFailure('');
    onToken('');
    request
      .call(backend, scene)
      .then((next) => {
        if (run !== generation.current) return;
        setChallenge(next);
        setLoading(false);
      })
      .catch(() => {
        if (run !== generation.current) return;
        setChallenge(null);
        setLoading(false);
        report(t('验证题加载失败，请刷新页面后重试。'));
      });
    // onToken / onFailure 由父组件传入，变化不代表题目要重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, scene, t]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, resetKey]);

  const submit = useCallback(
    (answer: LocalCaptchaAnswer) => {
      if (!challenge || busy) return;
      const request = backend.captchaLocalVerify;
      if (!request) {
        report(t('本站没有启用本地人机验证。'));
        return;
      }
      setBusy(true);
      setFailure('');
      request
        .call(backend, { challenge_id: challenge.challenge_id, answer, scene })
        .then((solution) => {
          setSolved(true);
          onToken(solution.token);
        })
        .catch(() => {
          // 服务端一次失败即作废本题，自动换一题，免得用户对着作废的题反复试。
          load();
          report(t('答案不正确或已过期，请重新作答。'));
        })
        .finally(() => setBusy(false));
    },
    [backend, busy, challenge, load, onToken, report, scene, t],
  );

  if (loading) {
    return <p className="field-hint">{t('正在获取验证题…')}</p>;
  }

  return (
    <div className="captcha-field" aria-live="polite">
      {challenge && !solved ? (
        <ChallengeBody
          key={challenge.challenge_id}
          challenge={challenge}
          disabled={busy}
          onSubmit={submit}
          onReload={load}
        />
      ) : null}
      {failure ? (
        <Callout tone="warn" icon="alert">
          {failure}
        </Callout>
      ) : solved ? (
        <p className="field-hint">{t('已完成本地人机验证。')}</p>
      ) : null}
    </div>
  );
}

function ChallengeBody({
  challenge,
  disabled,
  onSubmit,
  onReload,
}: {
  challenge: LocalCaptchaChallenge;
  disabled: boolean;
  onSubmit: (answer: LocalCaptchaAnswer) => void;
  onReload: () => void;
}) {
  switch (challenge.kind) {
    case 'slider':
      return (
        <SliderChallenge
          challenge={challenge}
          disabled={disabled}
          onSubmit={onSubmit}
          onReload={onReload}
        />
      );
    case 'click':
      return (
        <ClickChallenge
          challenge={challenge}
          disabled={disabled}
          onSubmit={onSubmit}
          onReload={onReload}
        />
      );
    case 'select':
      return (
        <SelectChallenge
          challenge={challenge}
          disabled={disabled}
          onSubmit={onSubmit}
          onReload={onReload}
        />
      );
    default:
      return null;
  }
}

function ActionRow({
  children,
  disabled,
  onReload,
}: {
  children: ReactNode;
  disabled: boolean;
  onReload: () => void;
}) {
  const t = useT();
  return (
    <div className="row gap-8 captcha-actions">
      {children}
      <Button size="sm" variant="ghost" icon="refresh" disabled={disabled} onClick={onReload}>
        {t('换一题')}
      </Button>
    </div>
  );
}

/** 滑块题：拖动圆形拼图，让它落进图里的缺口。 */
function SliderChallenge({
  challenge,
  disabled,
  onSubmit,
  onReload,
}: {
  challenge: LocalCaptchaChallenge;
  disabled: boolean;
  onSubmit: (answer: LocalCaptchaAnswer) => void;
  onReload: () => void;
}) {
  const t = useT();
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startOffset: number; scale: number } | null>(
    null,
  );
  const [offset, setOffset] = useState(0);

  const width = challenge.width || 320;
  const height = challenge.height || 180;
  const pieceSize = challenge.piece_size || 52;
  const pieceTop = challenge.piece_top || 0;
  const maxOffset = challenge.max_offset ?? Math.max(width - pieceSize, 0);

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !stage.current) return;
    const rect = stage.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startOffset: offset,
      scale: width / rect.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = Math.round(
      Math.min(maxOffset, Math.max(0, current.startOffset + (event.clientX - current.startX) * current.scale)),
    );
    setOffset(next);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <div className="form-stack">
      <p className="field-hint">{t('拖动圆形拼图，让它落进图中的缺口，然后点「验证」。')}</p>
      <div
        ref={stage}
        className="captcha-stage"
        style={{ maxWidth: width }}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <img src={challenge.background} width={width} height={height} alt="" draggable={false} />
        <img
          className="captcha-piece"
          src={challenge.piece}
          alt=""
          draggable={false}
          style={{
            left: `${(offset / width) * 100}%`,
            top: `${(pieceTop / height) * 100}%`,
            width: `${(pieceSize / width) * 100}%`,
          }}
        />
      </div>
      <input
        type="range"
        className="captcha-range"
        min={0}
        max={maxOffset}
        value={offset}
        disabled={disabled}
        aria-label={t('拖动滑块调整拼图位置')}
        onChange={(event) => setOffset(Number(event.target.value))}
      />
      <ActionRow disabled={disabled} onReload={onReload}>
        <Button size="sm" disabled={disabled} onClick={() => onSubmit({ x: offset })}>
          {t('验证')}
        </Button>
      </ActionRow>
    </div>
  );
}

/** 点击题：点中图里所有的星星。 */
function ClickChallenge({
  challenge,
  disabled,
  onSubmit,
  onReload,
}: {
  challenge: LocalCaptchaChallenge;
  disabled: boolean;
  onSubmit: (answer: LocalCaptchaAnswer) => void;
  onReload: () => void;
}) {
  const t = useT();
  const picture = useRef<HTMLImageElement | null>(null);
  const [points, setPoints] = useState<LocalCaptchaPoint[]>([]);
  const width = challenge.width || 320;
  const height = challenge.height || 200;
  const targetCount = challenge.target_count || 3;

  const pick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || points.length >= targetCount || !picture.current) return;
    const rect = picture.current.getBoundingClientRect();
    const point = captchaPointFromEvent(rect, event.clientX, event.clientY, width, height);
    if (!point) return;
    setPoints((current) => (current.length >= targetCount ? current : [...current, point]));
  };

  return (
    <div className="form-stack">
      <p className="field-hint">
        {t('点击图中的所有星星（共 {count} 个），然后点「验证」。', { count: targetCount })}
      </p>
      <div
        className="captcha-stage is-clickable"
        style={{ maxWidth: width }}
        onClick={pick}
        role="presentation"
      >
        <img
          ref={picture}
          src={challenge.image}
          width={width}
          height={height}
          alt=""
          draggable={false}
        />
        {points.map((point, index) => (
          <span
            key={`${point.x}:${point.y}:${index}`}
            className="captcha-marker"
            style={{
              left: `${((point.x + 0.5) / width) * 100}%`,
              top: `${((point.y + 0.5) / height) * 100}%`,
            }}
            aria-hidden="true"
          >
            {index + 1}
          </span>
        ))}
      </div>
      <p className="field-hint">
        {t('已选 {selected} / {total} 个', { selected: points.length, total: targetCount })}
      </p>
      <ActionRow disabled={disabled} onReload={onReload}>
        <Button
          size="sm"
          disabled={disabled || points.length !== targetCount}
          onClick={() => onSubmit({ points })}
        >
          {t('验证')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || points.length === 0}
          onClick={() => setPoints([])}
        >
          {t('重选')}
        </Button>
      </ActionRow>
    </div>
  );
}

/** 选择题：在九宫格里选出所有包含圆形的格子。 */
function SelectChallenge({
  challenge,
  disabled,
  onSubmit,
  onReload,
}: {
  challenge: LocalCaptchaChallenge;
  disabled: boolean;
  onSubmit: (answer: LocalCaptchaAnswer) => void;
  onReload: () => void;
}) {
  const t = useT();
  const picture = useRef<HTMLImageElement | null>(null);
  const [tiles, setTiles] = useState<number[]>([]);
  const width = challenge.width || 288;
  const height = challenge.height || 288;
  const rows = challenge.rows || 3;
  const cols = challenge.cols || 3;
  const targetCount = challenge.target_count || 3;

  const toggle = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || !picture.current) return;
    const rect = picture.current.getBoundingClientRect();
    const point = captchaPointFromEvent(rect, event.clientX, event.clientY, width, height);
    if (!point) return;
    const cell = captchaCellIndex(point, width, height, rows, cols);
    if (cell === null) return;
    setTiles((current) =>
      current.includes(cell) ? current.filter((value) => value !== cell) : [...current, cell].sort((a, b) => a - b),
    );
  };

  return (
    <div className="form-stack">
      <p className="field-hint">
        {t('选择所有包含圆形的图片（共 {count} 张），然后点「验证」。', { count: targetCount })}
      </p>
      <div
        className="captcha-stage is-clickable"
        style={{ maxWidth: width }}
        onClick={toggle}
        role="presentation"
      >
        <img
          ref={picture}
          src={challenge.image}
          width={width}
          height={height}
          alt=""
          draggable={false}
        />
        {tiles.map((cell) => {
          const row = Math.floor(cell / cols);
          const col = cell % cols;
          return (
            <span
              key={cell}
              className="captcha-cell is-selected"
              style={{
                left: `${(col / cols) * 100}%`,
                top: `${(row / rows) * 100}%`,
                width: `${100 / cols}%`,
                height: `${100 / rows}%`,
              }}
              aria-hidden="true"
            >
              <span className="captcha-cell-check">✓</span>
            </span>
          );
        })}
      </div>
      <p className="field-hint">
        {t('已选 {selected} / {total} 张', { selected: tiles.length, total: targetCount })}
      </p>
      <ActionRow disabled={disabled} onReload={onReload}>
        <Button size="sm" disabled={disabled || tiles.length === 0} onClick={() => onSubmit({ tiles })}>
          {t('验证')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || tiles.length === 0}
          onClick={() => setTiles([])}
        >
          {t('重选')}
        </Button>
      </ActionRow>
    </div>
  );
}
