import { useEffect, useRef, useState } from 'react';
import type { MediaQuotaBytes } from '../types';
import { bytesToMbString, parseMediaQuotaMbInput } from '../lib/mediaQuota';
import { errorText, useT } from '../lib/i18n';
import { Field, Input } from './ui';

/**
 * 站点媒体额度的自动保存输入框。
 *
 * 额度存在站点设置里（`PATCH /sites/{id}/settings` 的 `media_quota_bytes`），
 * 与储存设置的本机草稿是两条写入路径：这里只在停止输入 700ms 后单独提交一次，
 * 成功后由页面更新共享的 `Site`，媒体库等页面立即看到新额度。
 */

/** 停止编辑后多久写入，和站点设置页保持一致。 */
const SAVE_DELAY_MS = 700;

/** 额度按字节比较；null / undefined 都表示继承部署默认。 */
function savedSignature(value: MediaQuotaBytes | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? String(value) : value.trim();
}

function parsedSignature(value: number | null): string {
  return value === null ? '' : String(value);
}

export function MediaQuotaField({
  value,
  onSave,
  disabled = false,
}: {
  value: MediaQuotaBytes | undefined;
  onSave: (next: MediaQuotaBytes) => Promise<void>;
  disabled?: boolean;
}) {
  const t = useT();
  const saved = savedSignature(value);
  const savedText = bytesToMbString(value);
  const [draft, setDraft] = useState(savedText);
  /** idle 不显示状态；saving / saved 是给站长看的轻量反馈。 */
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(saved);
  const savedTextRef = useRef(savedText);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  /** 用户是否动过输入框：水合 / 外部更新不能覆盖正在编辑的内容。 */
  const touchedRef = useRef(false);
  const savingRef = useRef(false);
  /** 保存期间又输入过：当前请求结束后按最新草稿再保存一次。 */
  const queuedRef = useRef(false);
  const [revision, setRevision] = useState(0);

  // 外部额度变化（保存成功后的 Site 刷新、媒体库页修改）：未编辑时跟随，
  // 编辑中只在草稿仍等于旧基线时接收，避免冲掉用户刚输入的值。
  useEffect(() => {
    const previousText = savedTextRef.current;
    const changed = saved !== savedRef.current;
    savedRef.current = saved;
    savedTextRef.current = savedText;
    if (!changed) {
      if (!touchedRef.current) setDraft(savedText);
      return;
    }
    if (!touchedRef.current || draftRef.current === previousText) {
      setDraft(savedText);
      setError('');
      setState('idle');
      touchedRef.current = false;
    }
  }, [saved, savedText]);

  // 尾随防抖：非法输入只报错不写；保存中的输入排队到本次请求结束后再比一次，
  // 保证服务端最终拿到的是最后一次输入。
  useEffect(() => {
    if (disabled || !touchedRef.current) return;
    const parsed = parseMediaQuotaMbInput(draft);
    if (!parsed.valid) {
      setState('idle');
      setError(t('媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。'));
      return;
    }
    setError('');
    if (parsedSignature(parsed.value) === savedRef.current) {
      setState('idle');
      return;
    }
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }

    const timer = window.setTimeout(() => {
      if (savingRef.current) {
        queuedRef.current = true;
        return;
      }
      savingRef.current = true;
      setState('saving');
      onSaveRef
        .current(parsed.value)
        .then(() => {
          savedRef.current = parsedSignature(parsed.value);
          setState('saved');
          setError('');
        })
        .catch((err) => {
          setState('idle');
          setError(errorText(err));
        })
        .finally(() => {
          savingRef.current = false;
          if (queuedRef.current) {
            queuedRef.current = false;
            setRevision((current) => current + 1);
          }
        });
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, disabled, revision, t]);

  return (
    <Field
      label={t('本站媒体额度（MB）')}
      htmlFor="storage-media-quota"
      hint={t('媒体额度单位为 MB（1 MB = 1024 × 1024 字节）；留空继承部署默认，0 表示无限。')}
      error={error || null}
    >
      <Input
        id="storage-media-quota"
        aria-label={t('本站媒体额度（MB）')}
        type="text"
        inputMode="decimal"
        pattern="[0-9.]*"
        value={draft}
        disabled={disabled}
        placeholder={t('跟随部署默认')}
        onChange={(event) => {
          touchedRef.current = true;
          setDraft(event.target.value);
          setState('idle');
          setError('');
        }}
      />
      {state === 'saving' ? (
        <p className="tiny faint" role="status">
          {t('保存中')}…
        </p>
      ) : null}
      {state === 'saved' ? (
        <p className="tiny faint" role="status">
          {t('已自动保存')}
        </p>
      ) : null}
    </Field>
  );
}
