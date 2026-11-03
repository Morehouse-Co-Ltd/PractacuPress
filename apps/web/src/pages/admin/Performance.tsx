import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PerformanceSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import {
  DEFAULT_PERFORMANCE,
  readPerformance,
} from '../../lib/performance';
import {
  buildPerformanceEnvSnippet,
  buildPerformanceGatewaySnippet,
} from '../../lib/serverConfig';
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
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function PerformancePage() {
  const t = useT();
  useTitle(t('性能优化'));
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saved = useMemo(() => readPerformance(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<PerformanceSettings>(() => saved);
  const [preconnectText, setPreconnectText] = useState('');
  const dirty =
    JSON.stringify(draft) !== savedKey ||
    preconnectText !== saved.preconnect.join('\n');

  useEffect(() => {
    const next = readPerformance(config);
    setDraft(next);
    setPreconnectText(next.preconnect.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const save = () => {
    if (draft.db_max_open_conns > 0 && draft.db_max_idle_conns > draft.db_max_open_conns) {
      toast.push(
        'error',
        t('数据库连接数不合法'),
        t('空闲连接不能超过最大连接数；API 启动时会拒绝这组环境变量。'),
      );
      return;
    }
    const next = readPerformance({
      performance: { ...draft, preconnect: linesOf(preconnectText) },
    });
    updateConfig({ performance: next });
    setDraft(next);
    setPreconnectText(next.preconnect.join('\n'));
    toast.push(
      'ok',
      t('性能设置已保存'),
      t('前台行为立即生效；服务器超时、数据库连接池与网关缓存需要按片段部署后重启。'),
    );
    if (me) {
      noteActivity(
        backend,
        me.user.display_name,
        '修改性能设置',
        site?.name ?? '站点',
        `首屏 ${next.feed_limit} 条 · ${next.request_cache ? '请求缓存开启' : '请求缓存关闭'}`,
      );
    }
  };

  const reset = () => {
    updateConfig({ performance: DEFAULT_PERFORMANCE });
    setDraft(DEFAULT_PERFORMANCE);
    setPreconnectText('');
    toast.push('ok', t('已恢复默认性能设置'), t('前台请求量与缓存回到稳妥默认值。'));
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('性能优化')}</h1>
          <p>
            {t('目标不是让动画更快，而是减少 API 查询、重复请求与静态资源占用，让服务器在高峰时')}{' '}
            {t('仍能及时响应。浏览器侧设置立即生效；服务器超时、连接池与网关缓存会生成部署片段。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/access" className="btn btn-ghost btn-sm">
            <Icon name="shield" size={14} /> {t('访问限制')}
          </Link>
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="server" title={t('先减少请求，再谈压缩与缓存')}>
        {t('首页每次打开会读取文章与帖子各一次；把首屏条数调小、开启请求去重，可以直接减少')}{' '}
        {t('API 与数据库压力。服务器参数需要写入')}{' '}
        <code className="mono">.env</code> {t('并重启 API；')}{' '}
        {t('网关参数需要合并进 Nginx 或云 WAF。本页不会自动修改服务器。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('请求量与首屏负载')}</h3>
                <p>{t('减少每次页面访问读取的数据量，直接影响 API 与数据库的响应时间。')}</p>
              </div>
              <Badge tone="accent">{t('推荐优先调整')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <NumberField
                  id="performance-feed"
                  label={t('首页一次读取')}
                  hint={t('文章与帖子各取这么多条；组件多时建议 12–24。')}
                  value={draft.feed_limit}
                  min={1}
                  max={60}
                  unit={t('条')}
                  onChange={(feed_limit) => setDraft({ ...draft, feed_limit })}
                />
                <NumberField
                  id="performance-archive"
                  label={t('归档页每页')}
                  hint={t('归档页分页大小；越小首屏越快，翻页次数越多。')}
                  value={draft.archive_limit}
                  min={1}
                  max={60}
                  unit={t('条')}
                  onChange={(archive_limit) => setDraft({ ...draft, archive_limit })}
                />
              </div>
              <div className="form-stack mt-12">
                <Toggle
                  checked={draft.request_cache}
                  onChange={(request_cache) => setDraft({ ...draft, request_cache })}
                  label={t('合并重复请求并短缓存')}
                  description={t('同一路径的 GET 并发只发一次，短时间内重复打开直接复用结果；写入或切换账户后自动失效。')}
                />
                {draft.request_cache ? (
                  <NumberField
                    id="performance-cache-ttl"
                    label={t('缓存时长')}
                    hint={t('太短起不到减压作用，太长会让列表更新延迟。')}
                    value={draft.cache_ttl}
                    min={1}
                    max={120}
                    unit={t('秒')}
                    onChange={(cache_ttl) => setDraft({ ...draft, cache_ttl })}
                  />
                ) : null}
                <Toggle
                  checked={draft.lazy_media}
                  onChange={(lazy_media) => setDraft({ ...draft, lazy_media })}
                  label={t('媒体懒加载')}
                  description={t('视频只在播放时读取，图片和嵌入站点进入视口才加载，降低首屏带宽。')}
                />
                <Toggle
                  checked={draft.disable_animations}
                  onChange={(disable_animations) => setDraft({ ...draft, disable_animations })}
                  label={t('减少前台动效')}
                  description={t('关闭入场动画与过渡，降低低端设备的渲染压力；系统「减少动态效果」设置始终优先生效。')}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('预连接外部资源')}</h3>
                <p>{t('图片、字体或 CDN 在别的域名时，提前建立连接可以降低首屏等待。')}</p>
              </div>
              <Badge tone={draft.preconnect.length ? 'accent' : 'muted'}>
                {t('{count} 个来源', { count: draft.preconnect.length })}
              </Badge>
            </div>
            <div className="panel-body">
              <Field
                label={t('外部来源')}
                htmlFor="performance-preconnect"
                hint={t('一行一个 origin，例如 https://cdn.example.com；只保留 http(s)，最多 8 个。')}
              >
                <Textarea
                  id="performance-preconnect"
                  value={preconnectText}
                  onChange={(event) => setPreconnectText(event.target.value)}
                  placeholder={'https://cdn.example.com\nhttps://fonts.example.com'}
                  style={{ minHeight: 90, fontFamily: 'var(--mono)', fontSize: 12.5 }}
                />
              </Field>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('静态资源与网关缓存')}</h3>
                <p>{t('用于自建 Nginx 的压缩、缓存与超时参数；内置启动器已处理静态资源缓存。')}</p>
              </div>
              <Badge tone="muted">{t('需部署')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.gzip}
                  onChange={(gzip) => setDraft({ ...draft, gzip })}
                  label={t('网关开启 gzip')}
                  description={t('压缩 JS/CSS/JSON/SVG，减少传输时间；HTTPS 下应同时开启 gzip_vary。')}
                />
                <div className="form-grid">
                  <NumberField
                    id="performance-static-days"
                    label={t('静态资源缓存')}
                    hint={t('带 hash 的 assets 可以放心长缓存。')}
                    value={draft.static_cache_days}
                    min={1}
                    max={3650}
                    unit={t('天')}
                    onChange={(static_cache_days) => setDraft({ ...draft, static_cache_days })}
                  />
                  <NumberField
                    id="performance-keepalive"
                    label="keepalive"
                    hint={t('过大占用连接，过小会频繁重连。')}
                    value={draft.keepalive_timeout}
                    min={1}
                    max={3600}
                    unit={t('秒')}
                    onChange={(keepalive_timeout) => setDraft({ ...draft, keepalive_timeout })}
                  />
                  <NumberField
                    id="performance-body"
                    label={t('请求体上限')}
                    hint={t('上传图片/附件需要足够空间，但过大会放大内存占用。')}
                    value={draft.client_max_body_size_mb}
                    min={1}
                    max={2048}
                    unit="MB"
                    onChange={(client_max_body_size_mb) =>
                      setDraft({ ...draft, client_max_body_size_mb })
                    }
                  />
                  <NumberField
                    id="performance-proxy-timeout"
                    label={t('代理读超时')}
                    hint={t('避免慢请求长期占用 worker。')}
                    value={draft.proxy_read_timeout}
                    min={1}
                    max={3600}
                    unit={t('秒')}
                    onChange={(proxy_read_timeout) => setDraft({ ...draft, proxy_read_timeout })}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('API 与数据库连接')}</h3>
                <p>{t('服务器参数；写入 .env 后重启 API。0 表示沿用驱动默认。')}</p>
              </div>
              <Badge tone="muted">{t('需重启 API')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <NumberField
                  id="performance-api-read"
                  label={t('API 读超时')}
                  hint={t('慢请求不能无限占用连接。')}
                  value={draft.api_read_timeout}
                  min={1}
                  max={600}
                  unit={t('秒')}
                  onChange={(api_read_timeout) => setDraft({ ...draft, api_read_timeout })}
                />
                <NumberField
                  id="performance-api-idle"
                  label={t('API 空闲超时')}
                  hint={t('空闲 keep-alive 连接保留时长。')}
                  value={draft.api_idle_timeout}
                  min={1}
                  max={3600}
                  unit={t('秒')}
                  onChange={(api_idle_timeout) => setDraft({ ...draft, api_idle_timeout })}
                />
                <NumberField
                  id="performance-db-open"
                  label={t('数据库最大连接')}
                  hint={t('0 表示驱动默认：SQLite 1，MySQL/Postgres 25。')}
                  value={draft.db_max_open_conns}
                  min={0}
                  max={512}
                  unit={t('个')}
                  onChange={(db_max_open_conns) => setDraft({ ...draft, db_max_open_conns })}
                />
                <NumberField
                  id="performance-db-idle"
                  label={t('数据库空闲连接')}
                  hint={t('0 表示驱动默认；通常不超过最大连接数。')}
                  value={draft.db_max_idle_conns}
                  min={0}
                  max={512}
                  unit={t('个')}
                  onChange={(db_max_idle_conns) => setDraft({ ...draft, db_max_idle_conns })}
                />
                <NumberField
                  id="performance-db-lifetime"
                  label={t('连接生命周期')}
                  hint={t('0 表示不主动回收；默认 1800 秒。')}
                  value={draft.db_conn_max_lifetime}
                  min={0}
                  max={86400}
                  unit={t('秒')}
                  onChange={(db_conn_max_lifetime) =>
                    setDraft({ ...draft, db_conn_max_lifetime })
                  }
                />
              </div>
              {draft.db_max_open_conns > 0 &&
              draft.db_max_idle_conns > draft.db_max_open_conns ? (
                <Callout tone="danger" icon="alert" title={t('空闲连接不能超过最大连接数')}>
                  {t('API 启动时会拒绝这组配置。请先调小空闲连接，或把最大连接数调大。')}
                </Callout>
              ) : null}
              <Callout tone="warn" icon="alert" title={t('SQLite 通常只需要一个连接')}>
                {t('内置的 SQLite 模式默认只开一个连接，避免并发写入变成「database is locked」。')}{' '}
                {t('除非你很清楚自己在调什么，否则保持 0 即可。')}
              </Callout>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('部署片段')}</h3>
                <p>{t('按已保存的设置生成；复制后按实际路径、证书和数据库类型调整。')}</p>
              </div>
              <div className="row gap-8">
                <CopyButton
                  value={buildPerformanceGatewaySnippet(saved)}
                  label={t('复制 Nginx')}
                />
                <CopyButton
                  value={buildPerformanceEnvSnippet(saved)}
                  label={t('复制 API .env')}
                />
              </div>
            </div>
            <div className="panel-body">
              <pre className="auth-env-code">{buildPerformanceGatewaySnippet(saved)}</pre>
              <details className="mt-12">
                <summary className="link-btn">{t('展开 API 与数据库环境变量')}</summary>
                <pre className="auth-env-code">{buildPerformanceEnvSnippet(saved)}</pre>
              </details>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前效果')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('首页读取')}</span>
                  <span className="mini-value">
                    {t('{count} 条 × 2', { count: saved.feed_limit })}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('请求缓存')}</span>
                  <span className="mini-value">
                    {saved.request_cache ? t('{count} 秒', { count: saved.cache_ttl }) : t('关闭')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('媒体')}</span>
                  <span className="mini-value">{saved.lazy_media ? t('懒加载') : t('立即加载')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('动效')}</span>
                  <span className="mini-value">
                    {saved.disable_animations ? t('已减少') : t('跟随系统')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('API 超时')}</span>
                  <span className="mini-value">{t('{count} 秒', { count: saved.api_read_timeout })}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('数据库连接')}</span>
                  <span className="mini-value">
                    {saved.db_max_open_conns || t('驱动默认')}
                  </span>
                </div>
              </div>
              <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
                <Link to="/admin/access" className="btn btn-secondary btn-sm">
                  {t('配置请求限制')}
                </Link>
                <Link to="/admin/loading" className="btn btn-ghost btn-sm">
                  {t('加载动画')}
                </Link>
              </div>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认性能设置')}</h3>
            <p>{t('回到稳妥默认值；不会改变访问限制、域名或加载动画。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>

      <div className="row gap-8 mt-20">
        <Button disabled={!dirty} onClick={save} icon="check">
          {t('保存修改')}
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(readPerformance(config));
              setPreconnectText(saved.preconnect.join('\n'));
            }}
          >
            {t('放弃未保存的修改')}
          </Button>
        ) : (
          <span className="tiny faint">{t('没有未保存的修改')}</span>
        )}
      </div>
    </RoleGate>
  );
}
