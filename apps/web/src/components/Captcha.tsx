import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CaptchaScene,
  CaptchaStatus,
  HumanVerificationProvider,
  LocalCaptchaChallenge,
} from '../types';
import {
  CAPTCHA_GLOBAL,
  captchaAction,
  captchaSceneRequired,
  captchaScriptUrl,
  readCaptchaStatus,
} from '../lib/captcha';
import { useBackend } from '../lib/backend';
import { useT } from '../lib/i18n';
import { Button, Callout, Input } from './ui';

/**
 * 人机验证组件。
 *
 * 三件事必须一起成立才渲染：站点打开了开关、服务端具备校验能力、场景被勾选。
 * 判断统一走 `GET /captcha/status`，所以设置页里「已启用」但服务端没有密钥时，
 * 这里不会画一个不会校验的组件——那是这一版要修的谎。
 *
 * 第三方服务商的脚本来自其 CDN（Cloudflare / hCaptcha）；本地（自托管）验证不加载
 * 任何外部脚本：题目由本站接口下发，答对后把一次性 token 交给表单，跟第三方 token
 * 走同一条提交流程。代价是离线或网络受限时必须给出可读的降级提示，而不是留一块空白。
 */

/**
 * 同一个页面的多个表单共用一个状态请求，但缓存只有几秒：站长在设置里打开验证后，
 * 不刷新页面走到登录页也应该马上看到组件。缓存时间越短越不容易「设置生效了、
 * 表单还不知道」。
 */
const STATUS_CACHE_MS = 5_000;
let statusCache: { at: number; promise: Promise<CaptchaStatus> } | null = null;

/** 让下一次 `useCaptchaStatus` 重新向服务端要状态（设置页保存后调用）。 */
export function clearCaptchaStatusCache(): void {
  statusCache = null;
}

export interface CaptchaStatusState {
  status: CaptchaStatus | null;
  loading: boolean;
  /** 读取失败：旧后端没有端点，或服务端暂时不可用。 */
  failed: boolean;
}

/** 读站点当前执行的人机验证规则。 */
export function useCaptchaStatus(): CaptchaStatusState {
  const backend = useBackend();
  const [state, setState] = useState<CaptchaStatusState>({
    status: null,
    loading: true,
    failed: false,
  });

  useEffect(() => {
    let alive = true;
    const request = backend.captchaStatus;
    if (!request) {
      // 旧后端 / 演示后端：没有状态端点，按未启用处理，表单照常提交。
      setState({ status: readCaptchaStatus(null), loading: false, failed: false });
      return () => {
        alive = false;
      };
    }
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      statusCache = { at: Date.now(), promise: request.call(backend) };
    }
    statusCache.promise
      .then((status) => {
        if (alive) setState({ status, loading: false, failed: false });
      })
      .catch(() => {
        statusCache = null;
        if (alive) setState({ status: null, loading: false, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [backend]);

  return state;
}

/** 已加载的脚本按地址去重：同一页的登录 / 注册两个表单只会加载一次。 */
const scriptPromises = new Map<string, Promise<void>>();

function loadCaptchaScript(url: string): Promise<void> {
  const existing = scriptPromises.get(url);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`captcha script failed: ${url}`));
    document.head.appendChild(script);
  }).catch((err) => {
    // 失败不缓存：网络恢复后重试仍然可能成功。
    scriptPromises.delete(url);
    throw err;
  });
  scriptPromises.set(url, promise);
  return promise;
}

/** 各服务商脚本挂到 window 上的最小接口，只声明这里用到的部分。 */
interface CaptchaWidgetApi {
  render(
    container: HTMLElement,
    options: Record<string, unknown>,
  ): string | number;
  reset?(widgetId?: string | number): void;
}

declare global {
  interface Window {
    turnstile?: CaptchaWidgetApi;
    hcaptcha?: CaptchaWidgetApi;
  }
}

function widgetApi(provider: HumanVerificationProvider): CaptchaWidgetApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const name = CAPTCHA_GLOBAL[provider];
  if (!name) return undefined;
  return (window as unknown as Record<string, CaptchaWidgetApi | undefined>)[name];
}

export interface CaptchaFieldProps {
  scene: CaptchaScene;
  /** `GET /captcha/status` 的结果；null 表示还没读到。 */
  status: CaptchaStatus | null;
  /** 拿到 token 时回调；token 一次性，提交失败后要清空。 */
  onToken: (token: string) => void;
  /** 变更这个值会重置组件（例如提交失败后要求重新验证）。 */
  resetKey?: number;
  /** 组件自己加载失败时回调，让表单可以禁用提交按钮。 */
  onFailure?: (message: string) => void;
}

/**
 * 渲染一个验证组件并把 token 交给父表单。
 *
 * `effective` 为假（站点关掉、服务端没能力校验、或没读状态）时返回 null：不占位、
 * 不诱导用户，也不假装验证过。
 */
export function CaptchaField({
  scene,
  status,
  onToken,
  resetKey = 0,
  onFailure,
}: CaptchaFieldProps) {
  const t = useT();
  const container = useRef<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState('');
  const required = captchaSceneRequired(status, scene);

  const notifyFailure = useCallback(
    (message: string) => {
      setFailure(message);
      onFailure?.(message);
    },
    [onFailure],
  );

  useEffect(() => {
    // 本地验证由 LocalChallengeField 自己的 effect 取题，这里不加载脚本。
    if (!required || !status || status.provider === 'local' || !container.current) return;
    let alive = true;
    const target = container.current;
    target.innerHTML = '';
    setFailure('');
    onToken('');

    const script = captchaScriptUrl(status.provider);
    if (!script) return;
    loadCaptchaScript(script)
      .then(() => {
        if (!alive) return;
        const api = widgetApi(status.provider);
        if (!api) {
          notifyFailure(t('验证组件没有就绪。请刷新页面后重试。'));
          return;
        }
        const options: Record<string, unknown> = {
          sitekey: status.site_key,
          theme: 'auto',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(''),
          'error-callback': () => notifyFailure(t('人机验证组件运行失败，请刷新页面重试。')),
        };
        if (status.provider === 'turnstile') options.action = captchaAction(scene);
        api.render(target, options);
      })
      .catch(() => {
        if (alive) {
          notifyFailure(
            t('验证组件没能加载。请检查网络或关闭拦截扩展后刷新页面；如果一直失败，请联系站长。'),
          );
        }
      });

    return () => {
      alive = false;
    };
    // status 与 scene 变化都要重挂；resetKey 只用于人为重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [required, scene, status?.provider, status?.site_key, resetKey]);

  if (!required || !status) return null;

  if (status.provider === 'local') {
    return (
      <LocalChallengeField
        scene={scene}
        resetKey={resetKey}
        onToken={onToken}
        onFailure={onFailure}
      />
    );
  }

  return (
    <div className="captcha-field" aria-live="polite">
      <div ref={container} />
      {failure ? (
        <Callout tone="warn" icon="alert">
          {failure}
        </Callout>
      ) : (
        <p className="field-hint">{t('受本站人机验证保护。')}</p>
      )}
    </div>
  );
}

/** 本地（自托管）验证：显示题目、收答案，答对后把 token 交给表单。 */
function LocalChallengeField({
  scene,
  resetKey,
  onToken,
  onFailure,
}: {
  scene: CaptchaScene;
  resetKey: number;
  onToken: (token: string) => void;
  onFailure?: (message: string) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const [challenge, setChallenge] = useState<LocalCaptchaChallenge | null>(null);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(true);
  const [solving, setSolving] = useState(false);
  const [solved, setSolved] = useState(false);
  const [failure, setFailure] = useState('');
  /** 只接受最新一次取题请求的应答，避免「换一题」被旧响应覆盖。 */
  const generation = useRef(0);

  const load = useCallback(() => {
    const request = backend.captchaLocalChallenge;
    if (!request) {
      setLoading(false);
      const message = t('本站没有启用本地人机验证。');
      setFailure(message);
      onFailure?.(message);
      return;
    }
    const run = ++generation.current;
    setLoading(true);
    setSolved(false);
    setAnswer('');
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
        const message = t('验证题加载失败，请刷新页面后重试。');
        setFailure(message);
        onFailure?.(message);
      });
    // onToken / onFailure 由父组件传入，变化不代表题目要重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, scene, t]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, resetKey]);

  const submit = () => {
    if (!challenge || solving || solved) return;
    const value = Number(answer.trim());
    if (!answer.trim() || !Number.isInteger(value)) {
      setFailure(t('请填写整数答案。'));
      return;
    }
    const request = backend.captchaLocalVerify;
    if (!request) {
      const message = t('本站没有启用本地人机验证。');
      setFailure(message);
      onFailure?.(message);
      return;
    }
    setSolving(true);
    setFailure('');
    request
      .call(backend, {
        challenge_id: challenge.challenge_id,
        answer: value,
        scene,
      })
      .then((solution) => {
        setSolved(true);
        onToken(solution.token);
      })
      .catch(() => {
        // 服务端一次失败即作废本题，自动换一题，免得用户对着作废的题反复试。
        load();
        setFailure(t('答案不正确或已过期，请重新作答。'));
      })
      .finally(() => setSolving(false));
  };

  return (
    <div className="captcha-field" aria-live="polite">
      {loading ? (
        <p className="field-hint">{t('正在获取验证题…')}</p>
      ) : challenge ? (
        <div className="form-stack">
          <p className="field-hint">{t('请回答下面的算术题，证明你是真人：')}</p>
          <p className="field-hint" style={{ fontSize: '1.05rem', color: 'var(--text)' }}>
            {challenge.question}
          </p>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={answer}
              disabled={solving || solved}
              placeholder={t('答案')}
              aria-label={t('验证答案')}
              style={{ maxWidth: 160 }}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={solving}
              disabled={solved || !answer.trim()}
              onClick={submit}
            >
              {solved ? t('已验证') : t('验证')}
            </Button>
            <Button size="sm" variant="ghost" icon="refresh" disabled={solving} onClick={load}>
              {t('换一题')}
            </Button>
          </div>
        </div>
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
