import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StorageScope, StorageScopeSettings, StorageSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import {
  DEFAULT_STORAGE,
  STORAGE_SCOPES,
  buildStorageEnvSnippet,
  normalizeStorage,
  readStorage,
  storageUrlError,
} from '../../lib/storage';
import { useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Tabs,
} from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';

/** 用途固定顺序与图标；文案在组件里按当前语言取。 */
const SCOPE_META: {
  scope: StorageScope;
  icon: IconName;
}[] = [
  {
    scope: 'content',
    icon: 'file',
  },
  {
    scope: 'site',
    icon: 'image',
  },
  {
    scope: 'avatar',
    icon: 'user',
  },
  {
    scope: 'attachment',
    icon: 'upload',
  },
];

function overrideCount(settings: StorageSettings): number {
  return STORAGE_SCOPES.filter((scope) => settings.scopes[scope].driver !== 'inherit').length;
}

export function StoragePage() {
  const t = useT();
  useTitle(t('存储策略'));
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saved = useMemo(() => readStorage(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<StorageSettings>(() => saved);
  // 密钥只留在组件状态里，用于生成 .env 片段；刷新页面后就没了。
  const [secret, setSecret] = useState('');
  const dirty = JSON.stringify(draft) !== savedKey;

  const driverItems = [
    { key: 'local' as const, label: t('本地存储') },
    { key: 's3' as const, label: t('云对象存储') },
  ];

  const scopeDriverItems = [
    { key: 'inherit' as const, label: t('沿用全局') },
    { key: 'local' as const, label: t('本地磁盘') },
    { key: 's3' as const, label: t('云对象存储') },
  ];

  const scopeCardLabel: Record<StorageScope, string> = {
    content: t('文章媒体'),
    site: t('站点图片'),
    avatar: t('用户头像'),
    attachment: t('用户数据 / 附件'),
  };

  const scopeShortLabel: Record<StorageScope, string> = {
    content: t('文章媒体'),
    site: t('站点图片'),
    avatar: t('用户头像'),
    attachment: t('用户数据/附件'),
  };

  const scopeDescription: Record<StorageScope, string> = {
    content: t('文章与帖子里插入的图片、封面等；正文本身不在媒体存储里。'),
    site: t('站点图标、分享图与首页编排引用的站点级图片。'),
    avatar: t('成员头像；访问频繁、体积小，可以单独放本地或 CDN 桶。'),
    attachment: t('用户上传的附件与私有数据，通常需要鉴权后才能访问。'),
  };

  const driverLabel = (driver: StorageScopeSettings['driver']): string => {
    if (driver === 'inherit') return t('沿用全局');
    return driver === 'local' ? t('本地磁盘') : t('云对象存储');
  };

  useEffect(() => {
    setDraft(readStorage(config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const snippet = buildStorageEnvSnippet(saved, secret);
  const draftOverrides = overrideCount(draft);
  const savedOverrides = overrideCount(saved);
  const hasScopedS3 = STORAGE_SCOPES.some(
    (scope) => draft.scopes[scope].driver === 's3',
  );
  const globalLocalDir = draft.local_dir || DEFAULT_STORAGE.local_dir;
  const scopeLocalHint = t(
    '留空时由服务器使用「全局目录 / 用途名」（约 {dir}/content 等）；建议显式填写。',
    { dir: globalLocalDir },
  );

  const patchScope = (scope: StorageScope, patch: Partial<StorageScopeSettings>) => {
    setDraft({
      ...draft,
      scopes: {
        ...draft.scopes,
        [scope]: { ...draft.scopes[scope], ...patch },
      },
    });
  };

  const save = () => {
    const next = normalizeStorage(draft);
    if (next.driver === 's3' && !next.s3_bucket) {
      toast.push(
        'error',
        t('云端存储需要桶名'),
        t('STORAGE_S3_BUCKET 在 STORAGE_DRIVER=s3 时是必填项，API 启动会直接拒绝这组环境变量。'),
      );
      return;
    }
    const endpointError = storageUrlError(next.s3_endpoint);
    if (endpointError) {
      toast.push('error', t('Endpoint 格式不对'), t('Endpoint {error}', { error: endpointError }));
      return;
    }
    const publicError = storageUrlError(next.s3_public_base_url);
    if (publicError) {
      toast.push(
        'error',
        t('公开访问地址格式不对'),
        t('公开访问地址{error}', { error: publicError }),
      );
      return;
    }
    for (const scope of STORAGE_SCOPES) {
      const value = next.scopes[scope];
      if (value.driver === 's3' && !value.s3_bucket) {
        toast.push(
          'error',
          t('{scope}缺少桶名', { scope: scopeShortLabel[scope] }),
          t(
            '选择了云对象存储后必须填写桶名（STORAGE_{scope}_S3_BUCKET），否则这组分用途变量无法部署。',
            { scope: scope.toUpperCase() },
          ),
        );
        return;
      }
    }
    updateConfig({ storage: next });
    setDraft(next);
    toast.push(
      'ok',
      t('存储策略已保存'),
      t('选择已写入这台电脑的本地安装配置；把下方片段写进服务器 .env 并重启 API 之后，新的上传才会写到目标位置。'),
    );
    if (me) {
      noteActivity(
        backend,
        me.user.display_name,
        '修改存储策略',
        site?.name ?? '站点',
        next.driver === 'local'
          ? `本地存储 · ${next.local_dir} · 分用途覆盖 ${overrideCount(next)} 个`
          : `S3 兼容 · ${next.s3_bucket} · 分用途覆盖 ${overrideCount(next)} 个`,
      );
    }
  };

  const reset = () => {
    updateConfig({ storage: DEFAULT_STORAGE });
    setDraft(DEFAULT_STORAGE);
    setSecret('');
    toast.push(
      'ok',
      t('已恢复默认存储策略'),
      t('回到本地 ./data/media，所有用途都沿用全局；不会删除任何文件，也不会修改服务器的 .env。'),
    );
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('存储策略')}</h1>
          <p>
            {t('决定上传的图片与附件写到哪里：这台服务器的本地目录，或任何 S3 兼容的云对象存储。')}{' '}
            {t('全局设置之外，还可以按用途单独覆盖。浏览器只能保存部署意图，真正生效要靠服务器上的')}{' '}
            <code className="mono">.env</code> {t('与重启 API。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/media" className="btn btn-ghost btn-sm">
            <Icon name="image" size={14} /> {t('媒体库')}
          </Link>
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="database" title={t('保存只是写配置，部署才算切换')}>
        {t('本页只写入这台电脑的本地安装配置，并把选择翻译成可粘贴的 API')}{' '}
        <code className="mono">.env</code> {t('片段；服务器需要把片段写进')}{' '}
        <code className="mono">.env</code> {t('并重启 API 才生效。演示模式与真实后端行为一致：')}{' '}
        {t('都可以保存与生成片段，但演示模式没有真正的服务端进程可重启。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('全局存储位置')}</h3>
                <p>{t('分用途没有单独覆盖时，所有上传都沿用这里。')}</p>
              </div>
              <Badge tone={draft.driver === 's3' ? 'accent' : 'muted'}>
                {draft.driver === 's3' ? t('云对象存储') : t('本地磁盘')}
              </Badge>
            </div>
            <div className="panel-body">
              <Tabs
                value={draft.driver}
                onChange={(driver) => setDraft({ ...draft, driver })}
                items={driverItems}
              />

              {draft.driver === 'local' ? (
                <div className="form-stack mt-16">
                  <Field
                    label={t('本地目录')}
                    htmlFor="storage-local-dir"
                    hint={t('相对路径基于 API 进程的工作目录；Windows 一键包默认在 exe 同目录的 data/media。备份或迁移只需拷贝这个目录。')}
                  >
                    <Input
                      id="storage-local-dir"
                      value={draft.local_dir}
                      placeholder={DEFAULT_STORAGE.local_dir}
                      onChange={(event) => setDraft({ ...draft, local_dir: event.target.value })}
                    />
                  </Field>
                  <Callout tone="info" icon="server" title={t('适合单机与 Windows 一键包')}>
                    {t('本地存储没有额外的网络依赖，读取最快；但多实例部署时每台机器的磁盘各自独立，')}{' '}
                    {t('上传的文件在另一台机器上「看不到」。多实例请改用云对象存储，或自行挂载共享存储。')}
                  </Callout>
                </div>
              ) : (
                <div className="mt-16">
                  <div className="form-grid">
                    <Field
                      label={t('桶名（Bucket）')}
                      htmlFor="storage-bucket"
                      hint={t('s3 模式下必填；服务端启动时会尝试创建缺失的桶。')}
                    >
                      <Input
                        id="storage-bucket"
                        value={draft.s3_bucket}
                        placeholder="practacu-press"
                        autoComplete="off"
                        onChange={(event) => setDraft({ ...draft, s3_bucket: event.target.value })}
                      />
                    </Field>
                    <Field
                      label={t('区域（Region）')}
                      htmlFor="storage-region"
                      hint={t('AWS 填实际区域，例如 ap-southeast-1；MinIO 等也要求一个值，通常保持 us-east-1。')}
                    >
                      <Input
                        id="storage-region"
                        value={draft.s3_region}
                        placeholder={DEFAULT_STORAGE.s3_region}
                        autoComplete="off"
                        onChange={(event) => setDraft({ ...draft, s3_region: event.target.value })}
                      />
                    </Field>
                    <Field
                      label="Endpoint"
                      htmlFor="storage-endpoint"
                      hint={t('AWS 留空；MinIO 填 http://127.0.0.1:9000，阿里云 OSS / 腾讯云 COS 填各自 S3 兼容地址。')}
                    >
                      <Input
                        id="storage-endpoint"
                        value={draft.s3_endpoint}
                        placeholder="https://s3.example.com"
                        autoComplete="off"
                        onChange={(event) => setDraft({ ...draft, s3_endpoint: event.target.value })}
                      />
                    </Field>
                    <Field
                      label={t('对象前缀')}
                      htmlFor="storage-prefix"
                      hint={t('同一个桶放多个站点时用来隔离对象键，例如 practacu/；留空写在桶根。')}
                    >
                      <Input
                        id="storage-prefix"
                        value={draft.s3_prefix}
                        placeholder="practacu/"
                        autoComplete="off"
                        onChange={(event) => setDraft({ ...draft, s3_prefix: event.target.value })}
                      />
                    </Field>
                    <Field
                      label="Access Key"
                      htmlFor="storage-access-key"
                      hint={t('可以保存在本地安装配置里；建议使用只允许该桶读写的子账号。')}
                    >
                      <Input
                        id="storage-access-key"
                        value={draft.s3_access_key}
                        placeholder="AKIA…"
                        autoComplete="off"
                        onChange={(event) =>
                          setDraft({ ...draft, s3_access_key: event.target.value })
                        }
                      />
                    </Field>
                    <Field
                      label="Secret Key"
                      htmlFor="storage-secret-key"
                      aside={secret ? <Badge tone="accent">{t('仅本次')}</Badge> : null}
                      hint={t('只用于生成 .env 片段，不写入浏览器配置，保存后也不会回显；所有分用途共享这一份凭据。')}
                    >
                      <Input
                        id="storage-secret-key"
                        type="password"
                        value={secret}
                        placeholder={t('只在本页内存里保留')}
                        autoComplete="off"
                        onChange={(event) => setSecret(event.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="form-stack mt-12">
                    <Field
                      label={t('公开访问地址（可选）')}
                      htmlFor="storage-public-base"
                      hint={t('仅用于记录与排查，API 不读取这个值；公开读权限、CDN 与防盗链由桶策略决定。')}
                    >
                      <Input
                        id="storage-public-base"
                        value={draft.s3_public_base_url}
                        placeholder="https://cdn.example.com/media"
                        autoComplete="off"
                        onChange={(event) =>
                          setDraft({ ...draft, s3_public_base_url: event.target.value })
                        }
                      />
                    </Field>
                    <Callout tone="info" icon="globe" title={t('公开访问与防盗链由桶策略或 CDN 决定')}>
                      {t('对象存储默认是私有的。需要前台直接引用图片时，要么给桶开只读策略，要么在桶前面')}{' '}
                      {t('挂 CDN / 自定义域名；本页与 API 都不会替你放开权限。MinIO、阿里云 OSS、腾讯云')}{' '}
                      {t('COS 等都可以用 S3 兼容模式，只是 endpoint 不同；AWS S3 的 endpoint 留空即可。')}
                    </Callout>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('分用途存储')}</h3>
                <p>
                  {t('文章媒体、站点图片、头像与用户数据可以单独覆盖全局设置；选择「沿用全局」的用途')}{' '}
                  {t('不会生成任何变量。')}
                </p>
              </div>
              <Badge tone={draftOverrides ? 'accent' : 'muted'}>
                {draftOverrides ? t('{count} 个覆盖', { count: draftOverrides }) : t('全部沿用全局')}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="option-grid two">
                {SCOPE_META.map((meta) => {
                  const value = draft.scopes[meta.scope];
                  return (
                    <div
                      key={meta.scope}
                      className="option"
                      style={{ cursor: 'default', flexDirection: 'column', gap: 12 }}
                    >
                      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                        <span className="option-icon">
                          <Icon name={meta.icon} size={16} />
                        </span>
                        <div className="option-body">
                          <strong>{scopeCardLabel[meta.scope]}</strong>
                          <p>{scopeDescription[meta.scope]}</p>
                        </div>
                        <Badge
                          tone={
                            value.driver === 'inherit'
                              ? 'muted'
                              : value.driver === 's3'
                                ? 'accent'
                                : 'neutral'
                          }
                        >
                          {driverLabel(value.driver)}
                        </Badge>
                      </div>

                      <Tabs
                        value={value.driver}
                        onChange={(driver) => patchScope(meta.scope, { driver })}
                        items={scopeDriverItems}
                      />

                      {value.driver === 'local' ? (
                        <Field
                          label={t('本地目录')}
                          htmlFor={`storage-${meta.scope}-dir`}
                          hint={scopeLocalHint}
                        >
                          <Input
                            id={`storage-${meta.scope}-dir`}
                            value={value.local_dir}
                            placeholder={globalLocalDir}
                            onChange={(event) =>
                              patchScope(meta.scope, { local_dir: event.target.value })
                            }
                          />
                        </Field>
                      ) : null}

                      {value.driver === 's3' ? (
                        <div className="form-stack">
                          <Field
                            label={t('桶名（Bucket）')}
                            htmlFor={`storage-${meta.scope}-bucket`}
                            hint={t('必填；endpoint、区域与凭据沿用上面的全局 S3 设置。')}
                          >
                            <Input
                              id={`storage-${meta.scope}-bucket`}
                              value={value.s3_bucket}
                              placeholder={`practacu-${meta.scope}`}
                              autoComplete="off"
                              onChange={(event) =>
                                patchScope(meta.scope, { s3_bucket: event.target.value })
                              }
                            />
                          </Field>
                          <Field
                            label={t('对象前缀')}
                            htmlFor={`storage-${meta.scope}-prefix`}
                            hint={t('留空写在桶根；建议按用途分开，例如 practacu/content。')}
                          >
                            <Input
                              id={`storage-${meta.scope}-prefix`}
                              value={value.s3_prefix}
                              placeholder={`practacu/${meta.scope}`}
                              autoComplete="off"
                              onChange={(event) =>
                                patchScope(meta.scope, { s3_prefix: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                      ) : null}

                      {value.driver === 'inherit' ? (
                        <p className="tiny faint">
                          {t('沿用上面的全局{driver}{path}。', {
                            driver: draft.driver === 's3' ? t('云对象存储') : t('本地目录'),
                            path:
                              draft.driver === 's3' && draft.s3_bucket
                                ? `（${draft.s3_bucket}${draft.s3_prefix ? `/${draft.s3_prefix}` : ''}）`
                                : '',
                          })}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {draft.driver !== 's3' && hasScopedS3 ? (
                <Callout tone="warn" icon="alert" title={t('分用途的 S3 覆盖需要服务器有 S3 凭据')}>
                  {t('当前全局是本地存储，片段里不会生成')}{' '}
                  <code className="mono">STORAGE_S3_ENDPOINT</code> /{' '}
                  <code className="mono">STORAGE_S3_ACCESS_KEY</code>{' '}
                  {t('等全局凭据；分用途的 S3 覆盖会沿用')}{' '}
                  {t('这些值，请确认服务器已经通过 .env 或实例角色另行提供。')}
                </Callout>
              ) : null}
              <Callout tone="info" icon="info" title={t('分用途的 S3 只更换桶与前缀')}>
                {t('分用途覆盖沿用全局的 endpoint、区域与凭据；切换用途的存储同样不会搬运已有文件，')}{' '}
                {t('需要自己把旧目录或旧桶里的对象同步到新位置。')}
              </Callout>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('文章与帖子正文')}</h3>
                <p>{t('正文不是媒体文件，不在本页的存储范围内。')}</p>
              </div>
              <Badge tone="muted">{t('只读 · 存数据库')}</Badge>
            </div>
            <div className="panel-body">
              <Callout tone="info" icon="database" title={t('正文存关系数据库：SQLite / MySQL / Postgres')}>
                {t('标题、Markdown / 富文本正文、分类、评论与成员资料保存在服务端数据库，由')}{' '}
                <code className="mono">DATABASE_DRIVER</code> / <code className="mono">DATABASE_DSN</code>{' '}
                {t('决定；本页的本地目录与 S3 桶只存上传的图片、头像与附件。换数据库需要改服务端环境变量')}{' '}
                {t('并迁移数据，后台没有对应开关。')}
              </Callout>
              <div className="mini-list mt-12">
                <div className="mini-row">
                  <span className="mini-label">{t('正文与元数据')}</span>
                  <span className="mini-value">{t('数据库（不在本页）')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('图片 / 头像 / 附件')}</span>
                  <span className="mini-value">{t('本页的存储目标')}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('上传体积提示')}</h3>
                <p>{t('只用于前端提示，不会改变服务端上限。')}</p>
              </div>
              <Badge tone="muted">{t('非服务端参数')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <NumberField
                  id="storage-max-upload"
                  label={t('单文件上限提示')}
                  hint={t('API 与安全服务默认限制 25 MiB；要传更大的文件，需要同时调整 API 与安全服务，而不是只改这里。')}
                  value={draft.max_upload_mb}
                  min={1}
                  max={2048}
                  unit="MB"
                  onChange={(max_upload_mb) => setDraft({ ...draft, max_upload_mb })}
                />
              </div>
              {draft.max_upload_mb > 25 ? (
                <Callout tone="warn" icon="alert" title={t('超过 API 默认的 25 MiB 附件上限')}>
                  {t('这个值只影响页面提示。真正上传大文件前，需要按服务器规格调整 API 与安全服务的')}{' '}
                  {t('请求体上限，否则请求会被更早的一层拒绝。')}
                </Callout>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('部署片段')}</h3>
                <p>{t('按已保存的设置生成；inherit 的用途不写变量，密钥只来自上面的输入框。')}</p>
              </div>
              <CopyButton value={snippet} label={t('复制 .env')} />
            </div>
            <div className="panel-body">
              <pre className="auth-env-code">{snippet}</pre>
              <Callout tone="warn" icon="alert" title={t('保存不会让服务器立刻换存储')}>
                {t('把片段写进 API 的')}{' '}
                <code className="mono">.env</code> {t('（或启动器环境变量）并重启后才会生效。')}{' '}
                {t('切换存储不会自动搬运已有文件：旧目录里的图片仍在旧目录，旧桶里的对象仍在旧桶，')}{' '}
                {t('需要自己用 rclone / aws s3 sync 之类同步，或继续保留旧路径。')}
              </Callout>
            </div>
          </section>

          <div className="row gap-8 mt-20">
            <Button disabled={!dirty} onClick={save} icon="check">
              {t('保存修改')}
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(readStorage(config))}>
                {t('放弃未保存的修改')}
              </Button>
            ) : (
              <span className="tiny faint">{t('没有未保存的修改')}</span>
            )}
          </div>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前配置')}</h3>
                <p>{t('保存后立即写入本地安装配置。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('驱动')}</span>
                  <span className="mini-value">
                    {saved.driver === 's3' ? t('云对象存储') : t('本地磁盘')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('位置')}</span>
                  <span className="mini-value">
                    {saved.driver === 's3'
                      ? saved.s3_bucket || t('未填写桶')
                      : saved.local_dir || DEFAULT_STORAGE.local_dir}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">Endpoint</span>
                  <span className="mini-value">
                    {saved.driver === 's3' ? saved.s3_endpoint || t('AWS 默认') : '—'}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('凭据')}</span>
                  <span className="mini-value">
                    {saved.s3_access_key ? t('Access Key 已保存') : t('未填写（实例角色）')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('公开访问')}</span>
                  <span className="mini-value">
                    {saved.s3_public_base_url || t('由桶策略 / CDN 决定')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('分用途覆盖')}</span>
                  <span className="mini-value">
                    {savedOverrides
                      ? t('{count} 个用途', { count: savedOverrides })
                      : t('全部沿用全局')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('上传提示')}</span>
                  <span className="mini-value">{saved.max_upload_mb} MB</span>
                </div>
              </div>
              {savedOverrides ? (
                <div className="mini-list mt-12">
                  {SCOPE_META.filter(
                    (meta) => saved.scopes[meta.scope].driver !== 'inherit',
                  ).map((meta) => (
                    <div className="mini-row" key={meta.scope}>
                      <span className="mini-label">{scopeCardLabel[meta.scope]}</span>
                      <span className="mini-value">
                        {driverLabel(saved.scopes[meta.scope].driver)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
                <Link to="/admin/media" className="btn btn-secondary btn-sm">
                  {t('打开媒体库')}
                </Link>
                <Link to="/admin/performance" className="btn btn-ghost btn-sm">
                  {t('性能优化')}
                </Link>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('切换存储的顺序')}</h3>
                <p>{t('先备份，再切换。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <ol className="perf-steps">
                <li>{t('备份本地 data/media 目录，或记下旧桶名与前缀。')}</li>
                <li>{t('在本页保存新的存储策略，复制 .env 片段。')}</li>
                <li>{t('把片段写进服务器 .env，重启 API（不是刷新后台）。')}</li>
                <li>{t('分用途覆盖的 S3 只换桶与前缀，凭据仍用全局 STORAGE_S3_*。')}</li>
                <li>{t('上传图片验证；必要时用 rclone 迁移已有文件。')}</li>
                <li>{t('确认前台图片正常后，再清理旧目录或旧桶。')}</li>
              </ol>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认存储策略')}</h3>
            <p>{t('回到本地 ./data/media 且所有用途沿用全局；不会删除文件，也不会修改服务器的 .env。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>
    </RoleGate>
  );
}
