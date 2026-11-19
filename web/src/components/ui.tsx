import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { useToast } from '../lib/toast';
import { useT } from '../lib/i18n';
import { copyText } from '../lib/clipboard';
import { STATUS_LABEL, STATUS_TONE } from '../lib/format';
import type { ContentStatus } from '../types';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function buttonClass(
  variant: 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet' = 'primary',
  size: 'sm' | 'md' | 'lg' = 'md',
): string {
  return cx('btn', `btn-${variant}`, `btn-${size}`);
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(buttonClass(variant, size), className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner spinner-sm" aria-hidden /> : icon ? <Icon name={icon} size={15} /> : null}
      {children ? <span>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={15} /> : null}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  aside,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  aside?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={cx('field', error && 'field-invalid')}>
      <div className="field-head">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {aside ? <span className="field-aside">{aside}</span> : null}
      </div>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('input', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('textarea', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select-wrap">
      <select className={cx('select', className)} {...rest}>
        {children}
      </select>
      <Icon name="chevron-down" size={14} />
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
  dot,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent';
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: ContentStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function Avatar({ name, size = 36 }: { name?: string; size?: number }) {
  const text = (name ?? '·').trim();
  const chars = Array.from(text);
  const display =
    chars.length > 2 && /[a-zA-Z]/.test(chars[0])
      ? text
          .split(/\s+/)
          .map((p) => p[0])
          .slice(0, 2)
          .join('')
      : chars.slice(0, 1).join('');
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {display.toUpperCase()}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading-row">
      <span className="spinner" aria-hidden />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function PageLoading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="page-loading">
      <span className="spinner" aria-hidden />
      <span>{label ?? t('正在载入')}</span>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

/** 单行骨架。 */
export function SkeletonLine({ width = '100%' }: { width?: string }) {
  return <span className="pp-skel-line" style={{ width }} aria-hidden />;
}

/** 卡片骨架：一块封面 + 若干文字行，用于网格与大卡。 */
export function SkeletonCard({
  lines = 3,
  media = true,
}: {
  lines?: number;
  media?: boolean;
}) {
  return (
    <div className="pp-skel-card" aria-hidden>
      {media ? <span className="pp-skel-media" /> : null}
      <span className="pp-skel-card-body">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="pp-skel-line" style={{ width: `${94 - i * 14}%` }} />
        ))}
      </span>
    </div>
  );
}

/** 列表行骨架：日期列 + 标题/摘要，用于归档与列表。 */
export function SkeletonRow() {
  return (
    <div className="pp-skel-row" aria-hidden>
      <span className="pp-skel-line pp-skel-date" />
      <span className="pp-skel-row-body">
        <span className="pp-skel-line" style={{ width: '44%' }} />
        <span className="pp-skel-line" style={{ width: '82%' }} />
      </span>
    </div>
  );
}

/** 侧栏 / 小卡骨架：一个标题行 + 若干短行。 */
export function SkeletonPanel({ lines = 3 }: { lines?: number }) {
  return (
    <div className="pp-skel-panel" aria-hidden>
      <span className="pp-skel-line" style={{ width: '52%' }} />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="pp-skel-line" style={{ width: `${88 - i * 16}%` }} />
      ))}
    </div>
  );
}

/** 卡片网格骨架；列数由区块属性决定。 */
export function SkeletonGrid({
  columns = 2,
  count = 4,
}: {
  columns?: number;
  count?: number;
}) {
  return (
    <div
      className="pp-skel-grid"
      style={{ '--pp-skel-columns': columns } as CSSProperties}
      aria-hidden
    >
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = 'file',
  title,
  body,
  action,
  compact,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('empty', compact && 'empty-compact')}>
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // 只依赖 open：onClose 通常是内联箭头函数，放进依赖会让每次输入都重新
  // 执行 effect，把焦点抢回弹窗容器，导致输入框失焦。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  // Portal 到 body：后台内容区带 fade-up 动画（transform 恒为 matrix(1,0,0,1,0,0)），
  // 会成为 fixed 后代的包含块，导致弹窗只覆盖内容区、被页面滚动裁切。
  return createPortal(
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="modal-backdrop" aria-label={t('关闭')} onClick={onClose} />
      <div className="modal" style={{ maxWidth: width }} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭')}>
            <Icon name="close" size={17} />
          </button>
        </div>
        {children ? <div className="modal-body">{children}</div> : null}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  items: { key: T; label: string; count?: number }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={cx('tab', value === item.key && 'is-active')}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cx('toggle-row', disabled && 'is-disabled')}>
      <div>
        <label htmlFor={id} className="toggle-label">
          {label}
        </label>
        {description ? <p className="toggle-desc">{description}</p> : null}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={cx('switch', checked && 'is-on')}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const { push } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="quiet"
      size="sm"
      icon={copied ? 'check' : 'copy'}
      onClick={async () => {
        const ok = await copyText(value);
        if (ok) {
          setCopied(true);
          push('ok', t('已复制到剪贴板'));
          window.setTimeout(() => setCopied(false), 1800);
        } else {
          push('error', t('浏览器拒绝了剪贴板操作'), t('请手动选中并复制。'));
        }
      }}
    >
      {copied ? t('已复制') : (label ?? t('复制'))}
    </Button>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
  icon = 'info',
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: string;
  children: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className={`callout callout-${tone}`}>
      <Icon name={icon} size={17} />
      <div>
        {title ? <strong>{title}</strong> : null}
        <div className="callout-body">{children}</div>
      </div>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {description ? <p className="section-desc">{description}</p> : null}
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </div>
  );
}
