import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, Spinner } from '../../components/ui';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';

type VerifyState = 'verifying' | 'ok' | 'invalid';

/**
 * 邮箱验证链接的落地页。
 *
 * 链接由注册或「重新发送验证邮件」生成，令牌一次性使用；这个页面不要求登录，
 * 因为邮件客户端打开的浏览器可能还没有会话。验证成功后如果当前正好有会话，
 * 顺便刷新一次 /me，让个人主页立刻显示「已验证」。
 */
export function VerifyEmailPage() {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const backend = useBackend();
  const { me, reload } = useAuth();
  const [state, setState] = useState<VerifyState>(token ? 'verifying' : 'invalid');
  useTitle(t('验证邮箱'));

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    let alive = true;
    setState('verifying');
    backend.verifyEmail(token).then(
      () => {
        if (!alive) return;
        setState('ok');
        // `me` is deliberately read but not a dependency: reloading it changes the
        // object and would re-run the (single use) verification.
        if (me) void reload();
      },
      () => {
        if (alive) setState('invalid');
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, token]);

  if (state === 'verifying') {
    return (
      <div className="shell">
        <div className="mt-32">
          <Spinner label={t('正在验证邮箱…')} />
        </div>
      </div>
    );
  }

  if (state === 'ok') {
    return (
      <div className="shell">
        <div style={{ paddingTop: 56 }}>
          <EmptyState
            icon="check-circle"
            title={t('邮箱已验证')}
            body={t('这个邮箱地址已经通过验证，验证状态会显示在你的个人主页上。')}
            action={
              <Link to={me ? `/u/${me.user.id}` : '/'} className="btn btn-primary btn-sm">
                {me ? t('返回个人主页') : t('返回首页')}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div style={{ paddingTop: 56 }}>
        <EmptyState
          icon="x-circle"
          title={t('验证链接无效或已过期')}
          body={t('请登录后到个人主页重新发送验证邮件。')}
          action={
            <Link to={me ? `/u/${me.user.id}` : '/login'} className="btn btn-secondary btn-sm">
              {me ? t('返回个人主页') : t('去登录')}
            </Link>
          }
        />
      </div>
    </div>
  );
}
