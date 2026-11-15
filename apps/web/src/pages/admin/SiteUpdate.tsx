import { useMemo, useState } from 'react';
import { useAuth } from '../../lib/session';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import { APP_VERSION_LABEL } from '../../lib/appVersion';
import {
  UPDATE_CHANNELS,
  UPDATE_FREQUENCIES,
  UPDATE_MODES,
  UPDATE_SERVERS,
  canCheckForUpdates,
  evaluateUpdate,
  modeLabel,
  readUpdateSettings,
  serverOptionOf,
  styleLabel,
  updateIntervalMs,
  versionLabel,
} from '../../lib/siteUpdate';
import type { UpdateCheck, UpdateApplyResult } from '../../lib/updateClient';
import {
  UpdateCheckError,
  applyUpdateFromDir,
  checkForUpdate,
  updateErrorMessage,
} from '../../lib/updateClient';
import { applyHotUpdate } from '../../lib/hotUpdate';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Select,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

/**
 * 站点更新。
 *
 * 这一页现在能真正做事了：
 *
 * - 当前版本来自构建清单 `version.json`（标题 / 说明 / 版本 / 渠道四个核心字段）；
 * - 「检查更新」会让**服务端**去 GitHub（或所选镜像）读同一份清单再比较，服务端读不到
 *   时才由浏览器直连兜底；
 * - 手动更新：把新版本的构建目录交给启动器，它会不停进程地换上去（其他设备与访客
 *   不受影响，已打开的页面继续用旧资源直到下次加载）；
 * - 自动更新：后台按频率检查并提示，真正的自动下载安装属于还没实现的服务端部分，
 *   页面把这件事说清楚，不假装已经能全自动。
 *
 * 服务器地址是下拉栏（GitHub / jsDelivr / 本站），没有端口输入：所有更新源都是标准
 * 地址，端口由协议决定。
 */

const STATUS_TONE: Record<string, 'ok' | 'muted' | 'warn' | 'accent'> = {
  available: 'accent',
  up_to_date: 'ok',
  ahead: 'muted',
  channel_mismatch: 'warn',
  invalid: 'warn',
};

export function SiteUpdatePage() {
  const t = useT();
  useTitle(t('站点更新'));
  const { config, site, updateConfig } = useAuth();
  const toast = useToast();
  const saved = useMemo(() => readUpdateSettings(config.update), [config.update]);
  const [draft, setDraft] = useState(saved);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState('');
  const [buildDir, setBuildDir] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<UpdateApplyResult | null>(null);

  // 时间戳由检查动作自己更新，不参与“未保存的修改”判断。
  const dirty =
    JSON.stringify({
      mode: draft.mode,
      channel: draft.channel,
      frequency: draft.frequency,
      server_url: draft.server_url,
    }) !==
    JSON.stringify({
      mode: saved.mode,
      channel: saved.channel,
      frequency: saved.frequency,
      server_url: saved.server_url,
    });
  const serverOption = serverOptionOf(draft.server_url);
  const demo = config.mode === 'demo';
  const autoMode = draft.mode === 'auto';

  const verdict = useMemo(
    () =>
      result
        ? evaluateUpdate({
            localVersion: result.local.version,
            remote: result.remote,
            channel: draft.channel,
          })
        : null,
    [result, draft.channel],
  );

  const patch = (next: Partial<typeof draft>) => setDraft({ ...draft, ...next });

  const save = () => {
    const next = readUpdateSettings(draft);
    updateConfig({ update: next });
    setDraft(next);
    setError('');
    toast.push(
      'ok',
      t('更新设置已保存'),
      next.mode === 'auto'
        ? t('自动更新已开启，会按所选频率在后台检查；发现新版本只提示，不会打断编辑。')
        : t('手动更新已开启：只有你点「检查更新」时才会读取版本清单。'),
    );
  };

  const discard = () => {
    setDraft(saved);
    setError('');
  };

  const runCheck = async () => {
    if (!canCheckForUpdates(draft)) {
      setError(t('还没有选择更新源。'));
      return;
    }
    setChecking(true);
    setError('');
    try {
      const check = await checkForUpdate(draft);
      const next = readUpdateSettings({
        ...draft,
        last_checked_at: check.checked_at,
        last_remote_version: check.remote.version,
      });
      setResult(check);
      updateConfig({ update: next });
      setDraft(next);
      const judged = evaluateUpdate({
        localVersion: check.local.version,
        remote: check.remote,
        channel: draft.channel,
      });
      if (judged.available) {
        toast.push(
          'ok',
          t('发现新版本 {version}', { version: versionLabel(check.remote.version) }),
          check.remote.title,
        );
      } else if (judged.status === 'up_to_date') {
        toast.push('info', t('已是最新版本'), check.remote.title);
      } else {
        toast.push('info', t('没有可用的新版本'), check.remote.title);
      }
    } catch (err) {
      // 服务端给的细节（http 那类）比通用文案有用，直接展示；其余按错误码翻译，
      // 英文界面才不会看到一段中文键。
      const message =
        err instanceof UpdateCheckError
          ? err.code === 'http' && err.message
            ? err.message
            : t(updateErrorMessage(err.code))
          : t('更新检查失败，请稍后再试。');
      setError(message);
      toast.push('error', t('更新检查失败'), message);
    } finally {
      setChecking(false);
    }
  };

  const applyBuild = async () => {
    const dir = buildDir.trim();
    if (!dir) {
      setError(t('请先填入新版本构建目录的完整路径。'));
      return;
    }
    setApplying(true);
    setError('');
    try {
      const outcome = await applyUpdateFromDir(dir);
      setApplied(outcome);
      setBuildDir('');
      toast.push(
        'ok',
        t('已切换到新版本 {version}', { version: versionLabel(outcome.version) }),
        t('服务端没有停过；其他设备会继续用旧页面，直到它们下一次加载。'),
      );
    } catch (err) {
      const message =
        err instanceof UpdateCheckError
          ? err.code === 'http' && err.message
            ? err.message
            : t(updateErrorMessage(err.code))
          : t('切换失败，请检查目录后重试。');
      setError(message);
      toast.push('error', t('切换失败'), message);
    } finally {
      setApplying(false);
    }
  };

  const reloadIntoNewBuild = async () => {
    const version = applied?.version || result?.remote.version || '';
    const outcome = await applyHotUpdate(version);
    if (outcome.status === 'blocked') {
      toast.push('info', t('现在先不切换'), t('你正在输入内容，等手头这段写完再重新载入。'));
    } else if (outcome.status === 'failed') {
      toast.push('error', t('重新载入失败'), t('新版本的资源没有取全，已保持当前页面。'));
    }
  };

  const statusText = () => {
    if (!verdict) return '';
    switch (verdict.status) {
      case 'available':
        return t('发现新版本 {version}，可按下面的「手动更新」切换。', {
          version: versionLabel(verdict.remote?.version ?? ''),
        });
      case 'up_to_date':
        return t('已是最新版本。');
      case 'ahead':
        return t('本机版本比远端更新，可能是自己构建的版本。');
      case 'channel_mismatch':
        return t('远端是测试版，当前通道是稳定版，所以不提示更新。需要测试版请切换通道。');
      default:
        return t('更新源返回的不是有效的版本清单。');
    }
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('站点更新')}</h1>
          <p>
            {t(
              '查看当前版本与远端发布版本，决定手动还是自动检查更新。更新只替换程序文件，文章、页面、媒体与数据库都在 data 目录里。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="search"
            loading={checking}
            onClick={() => void runCheck()}
          >
            {t('检查更新')}
          </Button>
          <Button size="sm" icon="check" disabled={!dirty} onClick={save}>
            {t('保存设置')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="info" title={t('版本清单写在仓库里')}>
        {t(
          '仓库里的 apps/web/public/version.json 记录四个核心字段：标题、说明、版本号与发布渠道（稳定版 / 测试版 / 本地构建）。检查更新时由服务端读取这份清单，和本机版本比较。',
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
                  <span className="mini-label">{t('更新方式')}</span>
                  <span className="mini-value">{t(modeLabel(draft.mode))}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('更新源')}</span>
                  <span className="mini-value" data-site-update-server>
                    {t(serverOption?.name ?? '自定义地址')}
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
                <p>{t('选择手动更新还是自动更新，以及跟随哪个发布通道。')}</p>
              </div>
              <Badge tone={autoMode ? 'ok' : 'muted'} dot={autoMode}>
                {t(modeLabel(draft.mode))}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <div className="form-grid">
                  <Field
                    label={t('更新方式')}
                    htmlFor="site-update-mode"
                    hint={t(
                      UPDATE_MODES.find((item) => item.id === draft.mode)?.description ?? '',
                    )}
                  >
                    <Select
                      id="site-update-mode"
                      value={draft.mode}
                      onChange={(event) =>
                        patch({ mode: event.target.value as typeof draft.mode })
                      }
                    >
                      {UPDATE_MODES.map((item) => (
                        <option key={item.id} value={item.id}>
                          {t(item.name)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t('检查频率')}
                    htmlFor="site-update-frequency"
                    hint={
                      autoMode
                        ? t('自动更新时按这个频率在后台检查。')
                        : t('手动更新模式下只有点「检查更新」时才读取清单。')
                    }
                  >
                    <Select
                      id="site-update-frequency"
                      value={draft.frequency}
                      disabled={!autoMode}
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
                  <Field
                    label={t('更新通道')}
                    htmlFor="site-update-channel"
                    hint={t('稳定版通道忽略测试版；测试版通道同时接受两者。')}
                  >
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
                </div>
                {autoMode ? (
                  <p className="field-hint">
                    {t(
                      '自动更新只负责发现并提示新版本（{interval}检查一次），不会在你写作时刷新页面；真正把新版本装上仍需要你确认。',
                      {
                        interval:
                          updateIntervalMs(draft.frequency) === 0
                            ? t('每次打开后台')
                            : t('每隔一段时间'),
                      },
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel" data-site-update="server">
            <div className="panel-head">
              <div>
                <h3>{t('更新源')}</h3>
                <p>{t('服务端会去这个地址读取版本清单，再和本机版本比较。')}</p>
              </div>
              <Badge tone="muted">{t('标准地址，无需端口')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Field
                  label={t('服务器地址')}
                  htmlFor="site-update-server"
                  hint={t(serverOption?.note ?? '这个地址不在预置列表里，按自定义地址使用。')}
                >
                  <Select
                    id="site-update-server"
                    value={draft.server_url}
                    onChange={(event) => patch({ server_url: event.target.value })}
                  >
                    {UPDATE_SERVERS.map((item) => (
                      <option key={item.id} value={item.url}>
                        {t(item.name)}
                      </option>
                    ))}
                    {serverOption ? null : (
                      <option value={draft.server_url}>{draft.server_url}</option>
                    )}
                  </Select>
                </Field>
                <p className="field-hint mono" style={{ wordBreak: 'break-all' }}>
                  {draft.server_url}
                </p>

                <div className="row gap-8" style={{ alignItems: 'center' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="activity"
                    loading={checking}
                    onClick={() => void runCheck()}
                  >
                    {t('立即检查')}
                  </Button>
                  <span className="tiny faint">
                    {draft.last_checked_at
                      ? t('最近检查：{time}', { time: formatDateTime(draft.last_checked_at) })
                      : t('还没有检查过。')}
                  </span>
                </div>

                {error ? (
                  <p className="field-error" role="alert">
                    {error}
                  </p>
                ) : null}

                {result && verdict ? (
                  <div className="mini-list mt-12" data-site-update-result>
                    <div className="mini-row">
                      <span className="mini-label">{t('远端版本')}</span>
                      <span className="mini-value mono">
                        {versionLabel(result.remote.version)}{' '}
                        <Badge tone={STATUS_TONE[verdict.status] ?? 'muted'}>
                          {t(styleLabel(result.remote.style))}
                        </Badge>
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('发布说明')}</span>
                      <span className="mini-value">
                        {result.remote.title} · {result.remote.describe}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('检查结果')}</span>
                      <span className="mini-value">{statusText()}</span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('检查方式')}</span>
                      <span className="mini-value">
                        {result.server_side
                          ? t('由本机服务端读取清单')
                          : t('服务端不可用，浏览器直接读取清单')}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel" data-site-update="manual">
            <div className="panel-head">
              <div>
                <h3>{t('手动更新')}</h3>
                <p>{t('已经下载好新版本？把构建目录交给服务端，它会在不停进程的情况下换上去。')}</p>
              </div>
              <Badge tone="muted">{t('不停机')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Field
                  label={t('新版本构建目录')}
                  htmlFor="site-update-apply-dir"
                  hint={t(
                    '填解压后 dist 目录的完整路径（里面要有 index.html 与 version.json）。只有运行站点的这台电脑可以操作。',
                  )}
                >
                  <div className="row gap-8">
                    <Input
                      id="site-update-apply-dir"
                      value={buildDir}
                      placeholder={'C:\\PractacuPress\\dist'}
                      onChange={(event) => setBuildDir(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !applying) void applyBuild();
                      }}
                    />
                    <Button
                      size="sm"
                      icon="download"
                      loading={applying}
                      disabled={!buildDir.trim()}
                      onClick={() => void applyBuild()}
                    >
                      {t('立即切换')}
                    </Button>
                  </div>
                </Field>

                {applied ? (
                  <Callout tone="ok" icon="check-circle" title={t('新版本已经就位')}>
                    {t('已从 {previous} 切换到 {version}，服务端没有停止。', {
                      previous: applied.previous ? versionLabel(applied.previous) : t('未知版本'),
                      version: versionLabel(applied.version),
                    })}{' '}
                    {t('其他设备会继续用旧页面，直到它们下一次加载。')}
                    <div className="row gap-8 mt-8">
                      <Button size="sm" variant="secondary" icon="refresh" onClick={() => void reloadIntoNewBuild()}>
                        {t('重新载入到新版本')}
                      </Button>
                    </div>
                  </Callout>
                ) : null}

                <p className="tiny faint">
                  <Icon name="info" size={12} />{' '}
                  {t(
                    '自动下载并安装新版本还没实现（服务端部分稍后补上）；现在这一栏就是完整的手动更新路径。',
                  )}
                </p>
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
                  <span className="mini-label">{t('远端版本')}</span>
                  <span className="mini-value mono">
                    {result ? versionLabel(result.remote.version) : t('尚未检查')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('更新方式')}</span>
                  <span className="mini-value">{t(modeLabel(draft.mode))}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('更新通道')}</span>
                  <span className="mini-value">
                    {t(UPDATE_CHANNELS.find((item) => item.id === draft.channel)?.name ?? '')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('最近检查')}</span>
                  <span className="mini-value">
                    {draft.last_checked_at
                      ? formatDateTime(draft.last_checked_at)
                      : t('从未检查')}
                  </span>
                </div>
              </div>
              <p className="tiny faint mt-12">
                <Icon name="info" size={12} />{' '}
                {t('版本清单的四个字段：标题、说明、版本号与发布渠道。')}
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
