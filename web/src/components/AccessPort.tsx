import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';
import {
  changePort,
  collectLocalState,
  currentPort,
  DEFAULT_SITE_PORT,
  originForPort,
  readRuntime,
  type RuntimeInfo,
} from '../lib/runtime';
import { useToast } from '../lib/toast';
import { useT } from '../lib/i18n';
import { Badge, Button, Callout, Field, Input } from './ui';

/**
 * 访问端口面板：默认 8080，可以在后台直接改成其他端口。
 *
 * 只有 `npm start`（scripts/serve.mjs）提供的静态服务支持运行中切换；
 * Vite 开发服务器与 Go API 的端口在启动时确定，这里会给出重启命令而不是假装能改。
 */
export function AccessPortPanel() {
  const t = useT();
  const toast = useToast();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState(String(currentPort()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void readRuntime().then((info) => {
      if (!alive) return;
      setRuntime(info);
      setValue(String(info?.port ?? currentPort()));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
  const dirty = valid && runtime !== null && parsed !== runtime.port;
  // 开发服务器不能热切端口，给的是生产静态服务的重启命令，默认就是 8080。
  const command = `npm start -- --port ${DEFAULT_SITE_PORT}`;

  const apply = async () => {
    if (!runtime) return;
    if (!valid) {
      setError(t('端口需要是 1–65535 之间的整数。'));
      return;
    }
    if (parsed === runtime.port) return;
    setBusy(true);
    setError('');
    try {
      const result = await changePort(parsed, collectLocalState());
      const target = new URL(`${window.location.pathname}${window.location.search}`, result.origin);
      if (result.import_token) target.searchParams.set('pp_import', result.import_token);
      toast.push('ok', t('端口已切换'), t('正在跳转到 {origin}', { origin: result.origin }));
      window.setTimeout(() => window.location.assign(target.toString()), 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('端口切换失败，请稍后再试。'));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="admin-page-head embedded-section-head">
        <div>
          <h2>{t('访问端口')}</h2>
          <p>{t('站点对外提供访问的端口，默认 8080。')}</p>
        </div>
        <div className="admin-page-actions">
          <Badge tone={runtime ? 'ok' : 'muted'}>
            {loading ? t('读取中') : runtime ? t('静态服务') : t('开发服务器')}
          </Badge>
        </div>
      </div>

      <section className="panel">
        <div className="panel-body" style={{ paddingTop: 8 }}>
          {loading ? <p className="tiny faint">{t('正在读取运行时信息…')}</p> : null}

          {!loading && runtime ? (
            <>
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('当前地址')}</span>
                  <span className="mini-value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {runtime.origin}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('监听端口')}</span>
                  <span className="mini-value mono">
                    {runtime.port}
                    {runtime.port === DEFAULT_SITE_PORT ? ` · ${t('默认')}` : ''}
                  </span>
                </div>
              </div>

              <div className="mt-16">
                <Field
                  label={t('修改端口')}
                  htmlFor="access-port"
                  error={error || (!valid && value !== '' ? t('端口需要是 1–65535 之间的整数。') : null)}
                  hint={t('1–65535。应用后立即在新端口监听，本页会自动跳转。')}
                >
                  <div className="row gap-8">
                    <Input
                      id="access-port"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                      value={value}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty && !busy) void apply();
                      }}
                      style={{ width: 96 }}
                    />
                    <Button
                      size="sm"
                      icon="check"
                      loading={busy}
                      disabled={!dirty}
                      onClick={() => void apply()}
                    >
                      {t('应用')}
                    </Button>
                  </div>
                </Field>
              </div>
              <p className="tiny faint mt-8" style={{ lineHeight: 1.7 }}>
                {t('默认端口是 8080，地址里会写着')}
                <code className="mono"> :{t('端口')}</code>
                {t('。切换时本站的配置与演示数据会一起带到新地址。')}
              </p>
            </>
          ) : null}

          {!loading && !runtime ? (
            <>
              <Callout tone="info" icon="server" title={t('端口在启动时确定')}>
                {t('当前由开发服务器（Vite）提供页面，运行中不能改端口。用')}
                <code className="mono"> npm start </code>
                {t('运行的站点可以在后台直接修改。')}
              </Callout>
              <pre className="connect-commands mt-12">{command}</pre>
              <div className="row gap-8 mt-8">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={copied ? 'check' : 'copy'}
                  onClick={async () => {
                    const ok = await copyText(command);
                    setCopied(ok);
                    if (ok) toast.push('ok', t('命令已复制'), t('在 web 目录下执行。'));
                  }}
                >
                  {copied ? t('已复制') : t('复制命令')}
                </Button>
              </div>
              <p className="tiny faint mt-8">
                {t('当前地址 {origin} · 端口 {port}', {
                  origin: originForPort(currentPort()),
                  port: currentPort(),
                })}
              </p>
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}
