import { useState } from 'react';
import type { TwoFactorEnrollment } from '../types';
import { errorText, useT } from '../lib/i18n';
import { useBackend, isDemo } from '../lib/backend';
import { useAsync } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Badge, Button, Callout, CopyButton, Field, Input, Modal } from './ui';
import { Icon } from './Icon';
import { QrCode } from './QrCode';

const DEMO_TOTP_CODE = '123456';

type Stage = 'password' | 'scan' | 'codes';

/** 一次性恢复码列表：复制、下载、显示剩余数量。 */
function RecoveryCodeList({ codes }: { codes: string[] }) {
  const t = useT();
  return (
    <div className="recovery-codes">
      <ul className="recovery-code-list">
        {codes.map((code) => (
          <li key={code}>
            <code className="mono">{code}</code>
          </li>
        ))}
      </ul>
      <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
        <CopyButton value={codes.join('\n')} label={t('复制全部')} />
        <Button
          variant="secondary"
          size="sm"
          icon="download"
          onClick={() => {
            const body =
              'Practacu Press — two-factor recovery codes\n\n' +
              codes.join('\n') +
              '\n\nEach code works once. Keep this file offline.\n';
            const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'practacu-recovery-codes.txt';
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          {t('下载恢复码')}
        </Button>
      </div>
    </div>
  );
}

/**
 * 个人资料页的「两步验证」区块（FSD F-04）。
 *
 * 所有敏感操作都要求重新输入当前密码；关闭和重新生成恢复码还要求一次有效验证码
 * 或恢复码。恢复码只在确认 / 重新生成之后显示一次，离开弹窗即不可再查看。
 */
export function TwoFactorPanel() {
  const t = useT();
  const backend = useBackend();
  const toast = useToast();
  const demo = isDemo(backend);
  const status = useAsync(async () => backend.twoFactorStatus(), [backend]);

  const [flow, setFlow] = useState<null | 'enroll' | 'disable' | 'regenerate'>(null);
  const [stage, setStage] = useState<Stage>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  const resetFlow = () => {
    setFlow(null);
    setStage('password');
    setPassword('');
    setCode('');
    setError('');
    setEnrollment(null);
    setCodes([]);
  };

  const open = (next: 'enroll' | 'disable' | 'regenerate') => {
    resetFlow();
    setFlow(next);
  };

  const startEnrollment = async () => {
    if (!password) {
      setError(t('请输入当前密码。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const started = await backend.beginTwoFactorEnrollment(password);
      setEnrollment(started);
      setStage('scan');
      setPassword('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async () => {
    if (!/^\d{6}$/.test(code.trim()) && !demo) {
      setError(t('验证码是 6 位数字。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await backend.confirmTwoFactor(code.trim());
      setCodes(result.recovery_codes);
      setStage('codes');
      status.reload();
      toast.push('ok', t('两步验证已开启'), t('请把恢复码保存到安全的地方。'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitSecondFactor = async () => {
    if (!flow || flow === 'enroll') return;
    if (!password || !code.trim()) {
      setError(t('请输入当前密码和验证码。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (flow === 'disable') {
        await backend.disableTwoFactor({ password, code: code.trim() });
        toast.push('ok', t('两步验证已关闭'), t('下次登录只需要密码。'));
        status.reload();
        resetFlow();
      } else {
        const result = await backend.regenerateTwoFactorRecoveryCodes({
          password,
          code: code.trim(),
        });
        setCodes(result.recovery_codes);
        setStage('codes');
        status.reload();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const enabled = status.data?.enabled ?? false;
  const remaining = status.data?.recovery_codes_remaining ?? 0;
  // otpauth 的账户名在 label 里（otpauth://totp/<label>?…），展示成 "Issuer:account"。
  const accountLabel = enrollment
    ? decodeURIComponent(enrollment.otpauth_uri.split('totp/').pop()?.split('?')[0] ?? '')
    : '';

  return (
    <section className="panel mt-32 two-factor-panel">
      <div className="panel-head">
        <h3>
          <Icon name="shield" size={14} /> {t('两步验证')}
        </h3>
        <p>{t('登录时除了密码，还需要身份验证器生成的 6 位验证码。可以随时开启或关闭。')}</p>
      </div>
      <div className="panel-body">
        {status.loading ? (
          <p className="tiny faint">{t('读取中…')}</p>
        ) : (
          <div className="two-factor-status">
            <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge tone={enabled ? 'accent' : 'muted'}>
                {enabled ? t('已开启') : t('未开启')}
              </Badge>
              {enabled ? (
                <span className="tiny faint">
                  {t('剩余恢复码 {count} 个', { count: remaining })}
                  {status.data?.confirmed_at
                    ? ` · ${t('绑定于 {date}', {
                        date: new Date(status.data.confirmed_at).toLocaleDateString(),
                      })}`
                    : ''}
                </span>
              ) : (
                <span className="tiny faint">{t('当前只用密码登录。')}</span>
              )}
            </div>

            <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
              {enabled ? (
                <>
                  <Button variant="secondary" size="sm" onClick={() => open('regenerate')}>
                    {t('重新生成恢复码')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => open('disable')}>
                    {t('关闭两步验证')}
                  </Button>
                </>
              ) : (
                <Button size="sm" icon="shield" onClick={() => open('enroll')}>
                  {t('开启两步验证')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={flow === 'enroll'}
        title={stage === 'codes' ? t('保存恢复码') : t('开启两步验证')}
        description={
          stage === 'scan'
            ? t('用身份验证器扫描二维码，或手动输入下面的密钥，然后填写应用中显示的 6 位验证码。')
            : stage === 'codes'
              ? t('这些恢复码只显示这一次。每张设备丢失时可以用一个恢复码登录。')
              : t('需要先验证当前密码。')
        }
        onClose={resetFlow}
        footer={
          stage === 'password' ? (
            <>
              <Button variant="ghost" onClick={resetFlow}>
                {t('取消')}
              </Button>
              <Button loading={busy} onClick={startEnrollment} iconRight="arrow-right">
                {t('下一步')}
              </Button>
            </>
          ) : stage === 'scan' ? (
            <>
              <Button variant="ghost" onClick={resetFlow}>
                {t('取消')}
              </Button>
              <Button loading={busy} onClick={confirmEnrollment} iconRight="check">
                {t('确认开启')}
              </Button>
            </>
          ) : (
            <Button onClick={resetFlow}>{t('完成')}</Button>
          )
        }
      >
        {stage === 'password' ? (
          <Field label={t('当前密码')} hint={t('确认是你本人在操作。')}>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : null}

        {stage === 'scan' && enrollment ? (
          <div className="two-factor-enroll">
            <div className="two-factor-qr">
              <QrCode value={enrollment.qr_content} label={t('两步验证二维码')} />
            </div>
            <div className="two-factor-manual">
              <p className="tiny faint">{t('无法扫码？在身份验证器里手动添加：')}</p>
              <div className="two-factor-secret">
                <code className="mono">{enrollment.secret}</code>
                <CopyButton value={enrollment.secret} label={t('复制密钥')} />
              </div>
              <p className="tiny faint">
                {t('账户名：{account}', { account: accountLabel })}
              </p>
              {demo ? (
                <Callout tone="info" icon="info" title={t('演示模式')}>
                  {t('演示模式的验证码固定为 {code}。', { code: DEMO_TOTP_CODE })}
                </Callout>
              ) : null}
              <Field label={t('6 位验证码')}>
                <Input
                  value={code}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {stage === 'codes' ? (
          <>
            <Callout tone="warn" icon="alert" title={t('只显示这一次')}>
              {t('把它保存在离线的地方；同一份恢复码不会被再次展示。')}
            </Callout>
            <RecoveryCodeList codes={codes} />
          </>
        ) : null}

        {error ? (
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        ) : null}
      </Modal>

      <Modal
        open={flow === 'disable' || flow === 'regenerate'}
        title={flow === 'disable' ? t('关闭两步验证') : t('重新生成恢复码')}
        description={
          flow === 'disable'
            ? t('关闭后只用密码就能登录。需要当前密码，以及一次有效验证码或恢复码。')
            : t('旧恢复码会立即作废。需要当前密码，以及一次有效验证码或恢复码。')
        }
        onClose={resetFlow}
        footer={
          stage === 'codes' ? (
            <Button onClick={resetFlow}>{t('完成')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={resetFlow}>
                {t('取消')}
              </Button>
              <Button
                loading={busy}
                variant={flow === 'disable' ? 'danger' : 'primary'}
                onClick={submitSecondFactor}
              >
                {flow === 'disable' ? t('确认关闭') : t('重新生成')}
              </Button>
            </>
          )
        }
      >
        {stage === 'codes' ? (
          <>
            <Callout tone="warn" icon="alert" title={t('只显示这一次')}>
              {t('旧的恢复码已经全部作废。')}
            </Callout>
            <RecoveryCodeList codes={codes} />
          </>
        ) : (
          <div className="form-stack">
            <Field label={t('当前密码')}>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field
              label={t('验证码或恢复码')}
              hint={demo ? t('演示模式固定使用 {code}。', { code: DEMO_TOTP_CODE }) : undefined}
            >
              <Input
                value={code}
                autoComplete="one-time-code"
                placeholder={t('6 位验证码，或一个恢复码')}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
          </div>
        )}
        {error && stage !== 'codes' ? (
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        ) : null}
      </Modal>
    </section>
  );
}
