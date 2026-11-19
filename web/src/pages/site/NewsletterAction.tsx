import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, Skeleton } from '../../components/ui';
import { useBackend } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';

/**
 * 订阅确认 / 退订链接的落地页（契约 N1）。
 *
 * 两件事共用一页：链接由确认邮件或退订邮件生成，令牌一次性使用；动作由路由传入
 * 的 `mode` 决定，令牌从 `?token=` 读。这个页面不要求登录——邮件客户端打开的浏览
 * 器未必有会话。
 */
type ActionMode = 'confirm' | 'unsubscribe';

type ActionState = 'loading' | 'ok' | 'invalid';

export function NewsletterActionPage({ mode }: { mode: ActionMode }) {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const backend = useBackend();
  const [state, setState] = useState<ActionState>(token ? 'loading' : 'invalid');
  useTitle(mode === 'confirm' ? t('确认订阅') : t('退订邮件'));

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    let alive = true;
    setState('loading');
    const request =
      mode === 'confirm'
        ? backend.confirmNewsletter(token)
        : backend.unsubscribeNewsletter(token);
    request.then(
      () => {
        if (alive) setState('ok');
      },
      // 令牌过期、已被兑换或从未存在时服务端答 404；对用户来说都是「链接无效」。
      () => {
        if (alive) setState('invalid');
      },
    );
    return () => {
      alive = false;
    };
  }, [backend, token, mode]);

  if (state === 'loading') {
    return (
      <div className="shell">
        <div style={{ paddingTop: 56 }}>
          <div className="panel">
            <div className="panel-body">
              <Skeleton lines={4} />
              <p className="small muted mt-12">{t('正在处理订阅链接…')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'ok') {
    const confirmed = mode === 'confirm';
    return (
      <div className="shell">
        <div style={{ paddingTop: 56 }}>
          <EmptyState
            icon={confirmed ? 'check-circle' : 'mail'}
            title={confirmed ? t('订阅已确认') : t('已退订')}
            body={
              confirmed
                ? t('这个邮箱已经加入订阅名单，之后会收到新文章与刊物。')
                : t('这个邮箱不会再收到 Practacu Press 的邮件；如果改变主意，可以重新订阅。')
            }
            action={
              <Link to="/" className="btn btn-primary btn-sm">
                {t('返回首页')}
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
          icon="alert"
          title={t('链接无效或已过期')}
          body={
            mode === 'confirm'
              ? t('这个确认链接可能已经被使用过，或者已经过期。可以回到站点重新订阅。')
              : t('这个退订链接可能已经被使用过，或者已经过期。可以回到站点重新操作。')
          }
          action={
            <Link to="/" className="btn btn-secondary btn-sm">
              {t('返回首页')}
            </Link>
          }
        />
      </div>
    </div>
  );
}
