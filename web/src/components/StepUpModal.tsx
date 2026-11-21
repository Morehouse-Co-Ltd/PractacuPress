/**
 * 高威胁操作二次验证（step-up）：Provider + 密码弹窗。
 *
 * - `StepUpProvider` 挂在应用根部（`App.tsx`），向下提供 `useStepUp()`；
 * - `ensureStepUp()` 在令牌有效期内直接放行、不弹窗；否则弹出密码框，验证成功缓存
 *   令牌（按服务端 `expires_in` 过期），取消返回 false；
 * - 演示模式不伪造安全校验：直接放行并明确提示「演示模式不校验二次密码」。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StepUpSettings } from '../types';
import { ApiError } from '../lib/api';
import { useBackend } from '../lib/backend';
import { useAuth } from '../lib/session';
import { errorText, useT } from '../lib/i18n';
import {
  clearStepUpToken,
  getStepUpToken,
  StepUpContext,
  storeStepUpToken,
  type StepUpContextValue,
  type StepUpOptions,
} from '../lib/stepUp';
import { useToast } from '../lib/toast';
import { Button, Callout, Field, Input, Modal } from './ui';

interface PendingRequest {
  action?: string;
  resolve: (ok: boolean) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const backend = useBackend();
  const { me, site } = useAuth();
  const toast = useToast();
  const demo = backend.mode === 'demo';

  const [settings, setSettings] = useState<StepUpSettings | null>(null);
  const settingsRef = useRef<StepUpSettings | null>(null);
  /** 一次会话里只尝试读一次设置：读不到就按「保护开启」处理，不要每次操作都打请求。 */
  const attemptedRef = useRef(false);
  /** 演示模式的提示只出现一次，避免每点一下都弹同一句。 */
  const demoNotifiedRef = useRef(false);

  const [pending, setPending] = useState<{ action?: string } | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);

  const applySettings = useCallback((next: StepUpSettings | null) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  /** 最近一次确认过的登录身份（账户 + 站点）；换身份后旧令牌与旧设置都不可信。 */
  const identityRef = useRef('');
  const identityKey = me?.user.id && site?.id ? `${me.user.id}|${site.id}` : '';

  // 验证令牌按「一次浏览器会话」保存：刷新页面不重新询问，关闭浏览器后自然失效。
  // 这里不把「会话还没恢复」当成换账户，否则每次刷新都会清掉刚验证过的令牌。
  useEffect(() => {
    if (!identityKey) {
      // 退出登录 / 会话失联：当前浏览器窗口里不再保留任何验证。
      if (identityRef.current) {
        identityRef.current = '';
        applySettings(null);
        attemptedRef.current = false;
        clearStepUpToken();
      }
      return;
    }
    const previous = identityRef.current;
    if (previous === identityKey) return;
    identityRef.current = identityKey;
    if (!previous) return;
    applySettings(null);
    attemptedRef.current = false;
    demoNotifiedRef.current = false;
    clearStepUpToken();
  }, [identityKey, applySettings]);

  const loadSettings = useCallback(async (): Promise<StepUpSettings | null> => {
    if (!site?.id) return null;
    try {
      const found = await backend.stepUpSettings(site.id);
      applySettings(found);
      return found;
    } catch {
      // 旧后端 / 后端未就绪：不打断页面，按「保护开启」处理（见 ensureStepUp）。
      return null;
    }
  }, [applySettings, backend, site?.id]);

  const ensureStepUp = useCallback(
    async (action?: string, options?: StepUpOptions): Promise<boolean> => {
      if (demo) {
        if (!demoNotifiedRef.current) {
          demoNotifiedRef.current = true;
          toast.push(
            'info',
            t('演示模式不校验二次密码'),
            t('演示数据没有服务端安全校验，高危操作会直接执行；连接真实后端后才会真正要求验证。'),
          );
        }
        return true;
      }
      let known = settingsRef.current;
      if (known === null && !attemptedRef.current && me) {
        attemptedRef.current = true;
        known = await loadSettings();
      }
      const fresh = options?.fresh === true;
      if (!fresh) {
        // 设置读不到时按「保护开启」处理（fail-closed）：宁可多问一次密码，也不能在
        // 保护其实开着的时候把高危操作直接放过去。
        if (known && !known.enabled && !known.password_set) return true;
        // 本次浏览器会话内验证过、且仍属于当前账户与站点：直接放行，不重复弹窗。
        if (getStepUpToken(Date.now(), { userId: me?.user.id, siteId: site?.id })) return true;
      }
      return new Promise<boolean>((resolve) => {
        const previous = pendingRef.current;
        if (previous) {
          // 同时点两个高危操作时只保留最新一次，前一个按取消处理。
          pendingRef.current = null;
          previous.resolve(false);
        }
        pendingRef.current = { action, resolve };
        setPending({ action });
      });
    },
    [demo, loadSettings, me, site?.id, t, toast],
  );

  const verify = useCallback(
    async (password: string): Promise<void> => {
      try {
        const result = await backend.verifyStepUp(password);
        // 令牌存入 sessionStorage：本次浏览器会话内一直复用，关闭浏览器后失效。
        storeStepUpToken(result.token, result.expires_in, {
          userId: me?.user.id,
          siteId: site?.id,
        });
      } catch (err) {
        // 后端还没实现端点时说清楚是版本问题，而不是含糊的「资源不存在」。
        if (
          err instanceof ApiError &&
          (err.problem.status === 404 || err.problem.status === 405)
        ) {
          throw new Error(
            t('后端还没有提供二次验证端点（HTTP {status}）。请确认 API 已更新后重试。', {
              status: err.problem.status,
            }),
          );
        }
        throw err;
      }
    },
    [backend, me?.user.id, site?.id, t],
  );

  const finish = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }, []);

  const value = useMemo<StepUpContextValue>(
    () => ({ ensureStepUp, settings, applySettings, demo }),
    [ensureStepUp, settings, applySettings, demo],
  );

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpModal
        open={pending !== null}
        action={pending?.action}
        onCancel={() => finish(false)}
        onVerified={() => finish(true)}
        verify={verify}
      />
    </StepUpContext.Provider>
  );
}

/**
 * 密码弹窗。
 *
 * 只负责收集密码与展示错误：校验逻辑由 Provider 的 `verify` 注入，弹窗本身不碰
 * 令牌，也不认识 API 细节。
 */
export function StepUpModal({
  open,
  action,
  onCancel,
  onVerified,
  verify,
}: {
  open: boolean;
  action?: string;
  onCancel: () => void;
  onVerified: () => void;
  verify: (password: string) => Promise<void>;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError('');
    setBusy(false);
    // Modal 挂载后会把焦点放到弹窗容器上（父级 effect 晚于子级执行）。这里再抢一次，
    // 让用户可以直接开始输入密码，而不是先手动点一下输入框。
    const timer = window.setTimeout(() => {
      document.getElementById('stepup-password')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const submit = async () => {
    if (busy) return;
    if (!password) {
      setError(t('请输入密码。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await verify(password);
      setPassword('');
      onVerified();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('再次输入密码')}
      description={t('这是高威胁操作，需要再次验证身份。')}
      onClose={onCancel}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('取消')}
          </Button>
          <Button type="submit" form="stepup-form" loading={busy} icon="lock">
            {t('验证并继续')}
          </Button>
        </>
      }
    >
      <form
        id="stepup-form"
        className="stepup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {action ? <p className="stepup-action">{t('即将执行：{action}', { action })}</p> : null}
        <Field
          label={t('密码')}
          htmlFor="stepup-password"
          hint={t('可以用账户登录密码；站点设置了专用安全密码时，请使用专用安全密码。')}
        >
          <Input
            id="stepup-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError('');
            }}
          />
        </Field>
        {error ? (
          <Callout tone="danger" icon="alert" title={t('验证没有通过')}>
            {error}
          </Callout>
        ) : null}
        <p className="stepup-hint">
          {t('验证一次后，本次浏览器会话内的高危操作不再重复询问；关闭浏览器后需要重新验证。')}
        </p>
      </form>
    </Modal>
  );
}
