import { useCallback, useState } from 'react';
import { Button, Callout, Modal } from './ui';
import { useT } from '../lib/i18n';
import { passwordProblemText, type PasswordProblem } from '../lib/passwordPolicy';

/**
 * 弱密码确认弹窗。
 *
 * 服务端只有在请求显式携带 `confirm_weak_password` 时才接受弱密码；这个弹窗负责
 * 把“知道它弱，但仍然要用”的决定明确交给用户。空密码、纯空白与超长密码不会走到
 * 这里，它们由调用方直接报错。
 */
export function WeakPasswordDialog({
  open,
  problem,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  problem: PasswordProblem;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal
      open={open}
      title={t('密码强度较弱')}
      description={t('这个密码没有达到推荐的强度。继续使用会降低账户安全性，建议换一个更长、更独特的密码。')}
      onClose={onCancel}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('返回修改')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('仍然使用这个密码')}
          </Button>
        </>
      }
    >
      <Callout tone="warn" icon="alert">
        {passwordProblemText(problem, t)}
      </Callout>
      <p className="field-hint mt-12">
        {t('确认后会立即保存；建议之后换成更长的口令。')}
      </p>
    </Modal>
  );
}

interface PendingWeakPassword {
  problem: PasswordProblem;
  retry: () => void;
}

/**
 * 页面级弱密码确认状态。
 *
 * 调用方在提交前发现弱密码时调用 `ask(problem, () => submit(true))`；用户确认后
 * 才执行同一个提交函数。取消不会发请求，表单内容保持原样。
 */
export function useWeakPasswordConfirm() {
  const [pending, setPending] = useState<PendingWeakPassword | null>(null);

  const ask = useCallback((problem: PasswordProblem, retry: () => void) => {
    setPending({ problem, retry });
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(() => {
    const retry = pending?.retry;
    setPending(null);
    retry?.();
  }, [pending]);

  const dialog = (
    <WeakPasswordDialog
      open={pending !== null}
      problem={pending?.problem ?? 'short'}
      onCancel={cancel}
      onConfirm={confirm}
    />
  );

  return { ask, cancel, confirm, dialog };
}
