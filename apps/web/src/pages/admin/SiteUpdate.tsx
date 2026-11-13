import { useMemo, useState } from 'react';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { APP_VERSION_LABEL } from '../../lib/appVersion';
import {
  UPDATE_CHANNELS,
  UPDATE_FREQUENCIES,
  hasUpdateServer,
  isValidUpdatePort,
  readUpdateSettings,
  versionLabel,
} from '../../lib/siteUpdate';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Select,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

/**
 * 站点更新。
 *
 * 目前没有真实的更新服务，所以这一页先提供：站点显示名称、当前版本、
 * 自动更新开关、更新通道与检查频率，以及更新服务端地址 / 端口（允许留空）。
 * 空配置只表示“暂不检查更新”，不会影响站点其它功能；所有设置保存在本机后台配置。
 */
export function SiteUpdatePage() {
  const t = useT();
  useTitle(t('站点更新'));
  const { config, site, updateConfig } = useAuth();
  const toast = useToast();
  const saved = useMemo(() => readUpdateSettings(config.update), [config.update]);
  const [draft, setDraft] = useState(saved);
  const [portError, setPortError] = useState('');

  const dirty =
    JSON.stringify({ ...draft, last_checked_at: saved.last_checked_at }) !==
    JSON.stringify(saved);
  const configured = hasUpdateServer(draft);
  const demo = config.mode === 'demo';

  const patch = (next: Partial<typeof draft>) => setDraft({ ...draft, ...next });

  const save = () => {
    if (!isValidUpdatePort(draft.server_port)) {
      setPortError(t('端口必须是 1–65535 之间的整数。'));
      return;
    }
    const next = readUpdateSettings({
      ...draft,
      server_url: draft.server_url.trim(),
      server_port: draft.server_port.trim(),
    });
    updateConfig({ update: next });
    setDraft(next);
    setPortError('');
    toast.push(
      'ok',
      t('更新设置已保存'),
      configured
        ? t('更新服务端地址已记录；更新服务接入后生效。')
        : t('更新服务端留空，当前不会检查更新。'),
    );
  };

  const discard = () => {
    setDraft(saved);
    setPortError('');
  };

  const check = () => {
    toast.push(
      'info',
      t('更新服务暂未接入'),
      t('等更新服务端可用后，这里会显示可用的新版本与更新入口。'),
    );
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('站点更新')}</h1>
          <p>
            {t(
              '在这里查看站点显示名称与当前版本，并决定是否自动检查更新。更新服务端尚未接入，相关地址和端口可以暂时留空，不会影响其它功能。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="search"
            onClick={check}
            title={t('更新服务暂未接入')}
          >
            {t('检查更新')}
          </Button>
          <Button size="sm" icon="check" disabled={!dirty} onClick={save}>
            {t('保存设置')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="info" title={t('更新服务暂未接入')}>
        {t(
          '这一页先提供更新设置入口：当前版本来自前端构建，更新服务端地址与端口可以留空；设置先保存在本机后台配置里。等更新服务上线后，同样的设置会用于检查新版本；在此之前所有功能照常使用。',
        )}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel" data-site-update="identity">
            <div className="panel-head">
              <div>
                <h3>{t('当前站点')}</h3>
                <p>{t('站点显示名称与当前运行的软件版本。')}</p>
              </div>
              <Badge tone="accent">{versionLabel(APP_VERSION_LABEL)}</Badge>
            </div>
            <div className="panel-body">
              <dl className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('站点显示名称')}</span>
                  <span className="mini-value" data-site-update-name>
                    {site?.name?.trim() || t('未命名站点')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('当前版本')}</span>
                  <span className="mini-value mono">{versionLabel(APP_VERSION_LABEL)}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('运行模式')}</span>
                  <span className="mini-value">
                    {demo ? t('演示模式') : t('正式站点')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('更新服务端')}</span>
                  <span className="mini-value">
                    {configured ? `${draft.server_url}:${draft.server_port || '默认端口'}` : t('暂未配置')}
                  </span>
                </div>
              </dl>
              <p className="field-hint mt-12">
                {t('站点显示名称可在「站点设置 → 基本信息」里修改。')}
              </p>
            </div>
          </section>

          <section className="panel" data-site-update="settings">
            <div className="panel-head">
              <div>
                <h3>{t('更新设置')}</h3>
                <p>{t('选择是否自动检查更新，以及使用的更新通道。')}</p>
              </div>
              <Badge tone={draft.auto_update ? 'ok' : 'muted'} dot={draft.auto_update}>
                {draft.auto_update ? t('自动检查已开启') : t('手动检查')}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.auto_update}
                  onChange={(auto_update) => patch({ auto_update })}
                  label={t('自动检查更新')}
                  description={t('只检查并提示新版本，不会自动安装。更新服务接入后生效。')}
                />
                <div className="form-grid">
                  <Field label={t('更新通道')} htmlFor="site-update-channel">
                    <Select
                      id="site-update-channel"
                      value={draft.channel}
                      onChange={(event) =>
                        patch({ channel: event.target.value as typeof draft.channel })
                      }
                    >
                      {UPDATE_CHANNELS.map((item) => (
                        <option key={item.id} value={item.id}>
                          {t(item.name)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t('检查频率')}
                    htmlFor="site-update-frequency"
                    hint={t('仅在开启自动检查时使用。')}
                  >
                    <Select
                      id="site-update-frequency"
                      value={draft.frequency}
                      disabled={!draft.auto_update}
                      onChange={(event) =>
                        patch({ frequency: event.target.value as typeof draft.frequency })
                      }
                    >
                      {UPDATE_FREQUENCIES.map((item) => (
                        <option key={item.id} value={item.id}>
                          {t(item.name)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            </div>
          </section>

          <section className="panel" data-site-update="server">
            <div className="panel-head">
              <div>
                <h3>{t('更新服务端')}</h3>
                <p>{t('更新服务上线前，这两项可以留空。')}</p>
              </div>
              <Badge tone={configured ? 'ok' : 'muted'}>{configured ? t('已填写') : t('暂未配置')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <div className="form-grid">
                  <Field
                    label={t('服务器地址')}
                    htmlFor="site-update-server"
                    hint={t('留空表示暂不使用更新服务。')}
                  >
                    <Input
                      id="site-update-server"
                      value={draft.server_url}
                      placeholder="https://updates.example.com"
                      onChange={(event) => patch({ server_url: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('端口')}
                    htmlFor="site-update-port"
                    hint={t('留空使用协议默认端口。')}
                  >
                    <Input
                      id="site-update-port"
                      value={draft.server_port}
                      inputMode="numeric"
                      placeholder={t('默认端口')}
                      aria-invalid={portError ? true : undefined}
                      onChange={(event) => {
                        setPortError('');
                        patch({ server_port: event.target.value });
                      }}
                    />
                  </Field>
                </div>
                {portError ? (
                  <p className="field-error" role="alert">
                    {portError}
                  </p>
                ) : null}
                <div className="row gap-8" style={{ alignItems: 'center' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="activity"
                    disabled
                    title={t('更新服务暂未接入')}
                  >
                    {t('测试连接')}
                  </Button>
                  <span className="tiny faint">{t('更新服务暂未接入，连接测试会在接入后开放。')}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel" data-site-update="summary">
            <div className="panel-head">
              <div>
                <h3>{t('更新摘要')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('当前版本')}</span>
                  <span className="mini-value mono">{versionLabel(APP_VERSION_LABEL)}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('更新通道')}</span>
                  <span className="mini-value">
                    {t(UPDATE_CHANNELS.find((item) => item.id === draft.channel)?.name ?? '')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('自动检查')}</span>
                  <span className="mini-value">{draft.auto_update ? t('已开启') : t('已关闭')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('最近检查')}</span>
                  <span className="mini-value">
                    {draft.last_checked_at ? t('尚未接入更新服务') : t('从未检查')}
                  </span>
                </div>
              </div>
              <p className="tiny faint mt-12">
                <Icon name="info" size={12} /> {t('更新服务接入前，检查更新只会提示服务尚未接入。')}
              </p>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('更新不会动你的内容')}</h3>
            <p>
              {t('更新只替换程序文件；文章、页面、媒体与数据库都在 data 目录里，升级前仍建议先备份。')}
            </p>
          </div>
        </aside>
      </div>

      <div className="row gap-8 mt-20">
        <Button disabled={!dirty} onClick={save} icon="check">
          {t('保存设置')}
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={discard}>
            {t('放弃未保存的修改')}
          </Button>
        ) : (
          <span className="tiny faint">{t('没有未保存的修改')}</span>
        )}
      </div>
    </RoleGate>
  );
}
