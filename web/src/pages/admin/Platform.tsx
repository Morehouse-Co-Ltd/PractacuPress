import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PlatformSite } from '../../types';
import { useBackend, isDemo } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useAsync, useTitle, errorText } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  EmptyState,
  Field,
  Input,
  PageLoading,
  SectionHead,
  Select,
} from '../../components/ui';
import { Forbidden } from '../../components/Guards';
import { Icon } from '../../components/Icon';
import { PlatformTabs } from '../../components/PlatformTabs';
import { useWeakPasswordConfirm } from '../../components/WeakPasswordDialog';
import {
  passwordCreationProblem,
  passwordProblemText,
  weakPasswordProblem,
} from '../../lib/passwordPolicy';

/**
 * 平台控制台。
 *
 * 多站点能力过去只停留在数据模型里：站点只能靠 `go run ./cmd/seed` 创建，平台管理员
 * 也没有跨站运维面。这里补齐部署级入口：站点列表、新建（默认设计 + 初始管理员）、
 * 详情与进入某个站点的管理后台。
 *
 * 「进入」不是把当前访问令牌复用到别的租户：目标站点有自己的源，服务端签发短期交接
 * 令牌，浏览器在目标源兑换成正常会话（见 AuthProvider 的 `pp_switch` 处理）。
 */

/** 把服务端的拒绝原因翻译成一句可操作的话。 */
function entryReasonText(reason: string | undefined, t: (key: string) => string): string {
  switch (reason) {
    case 'domain_missing':
      return t('目标站点还没有绑定主域名。');
    case 'domain_unverified':
      return t('目标站点的主域名尚未通过验证，请先完成 TXT 验证。');
    case 'site_disabled':
      return t('目标站点已停用。');
    default:
      return t('目标站点暂时无法进入。');
  }
}

/** 域名状态徽标；平台控制台只读，不在这里触发验证。 */
function DomainBadge({ site }: { site: PlatformSite }) {
  const t = useT();
  if (!site.domain) return <Badge tone="muted">{t('未绑定域名')}</Badge>;
  if (site.domain_verified) return <Badge tone="ok">{t('已验证')}</Badge>;
  return <Badge tone="warn">{t('待验证')}</Badge>;
}

function visibilityLabel(value: PlatformSite['visibility_mode'], t: (key: string) => string): string {
  return value === 'members_only' ? t('仅成员') : t('公开浏览');
}

function publishLabel(value: PlatformSite['publish_mode'], t: (key: string) => string): string {
  switch (value) {
    case 'open':
      return t('开放发布');
    case 'role_based':
      return t('按角色发布');
    default:
      return t('审核发布');
  }
}

/** 同一个 SPA 在目标站点源上的后台入口。`/admin` 是 SPA 的规范路由。 */
function adminEntryUrl(domain: string): string {
  return `${window.location.protocol}//${domain}/admin`;
}

export function PlatformSitesPage() {
  const t = useT();
  useTitle(t('站点平台'));
  const backend = useBackend();
  const { me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState('');

  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';
  const { data, error, loading } = useAsync<PlatformSite[]>(
    () => (isPlatformAdmin ? backend.platformSites() : Promise.resolve([])),
    [backend, isPlatformAdmin],
  );
  const sites = data ?? [];

  if (!isPlatformAdmin) {
    return <Forbidden need={t('平台管理员')} />;
  }

  const enter = async (site: PlatformSite) => {
    if (busyId) return;
    setBusyId(site.id);
    try {
      const entry = await backend.enterPlatformSite(site.id);
      if (!entry.switchable) {
        toast.push('info', entryReasonText(entry.reason, t));
        return;
      }
      // 当前站点不需要换源：直接回到本站后台。
      if (!me || site.id === me.site_id) {
        navigate('/admin');
        return;
      }
      if (!entry.switch_token || !site.domain) {
        toast.push('info', entryReasonText('domain_missing', t));
        return;
      }
      // 跨源进入：目标站点自己的后台会用一次性令牌兑换正式会话。
      // 令牌放在片段里，避免随 Referer 泄露给第三方资源。
      const url = new URL(adminEntryUrl(site.domain));
      url.hash = `pp_switch=${encodeURIComponent(entry.switch_token)}`;
      window.location.assign(url.toString());
    } catch (err) {
      toast.push('error', errorText(err));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{t('站点平台')}</h1>
          <p>{t('管理部署内的所有站点：新建、查看状态、进入某个站点的管理后台。')}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/platform/new" className="btn btn-primary btn-sm">
            <Icon name="plus" size={14} /> {t('新建站点')}
          </Link>
        </div>
      </div>

      {demo ? (
        <Callout tone="info" title={t('演示模式')}>
          {t('演示模式只运行一个站点，无法新建或跨站进入；连接真实后端后可用。')}
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" title={t('加载站点失败')}>
          {errorText(error)}
        </Callout>
      ) : null}

      <div className="stat-grid">
        <div className="stat is-accent">
          <span>{t('部署站点')}</span>
          <b>{sites.length}</b>
          <small>{t('按创建时间排序')}</small>
        </div>
        <div className="stat">
          <span>{t('成员总数')}</span>
          <b>{sites.reduce((sum, site) => sum + site.member_count, 0)}</b>
          <small>{t('含暂停的成员')}</small>
        </div>
        <div className="stat">
          <span>{t('管理员总数')}</span>
          <b>{sites.reduce((sum, site) => sum + site.admin_count, 0)}</b>
          <small>{t('可进入后台的账户')}</small>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('全部站点')}</h3>
            <p>{t('平台管理员可以查看每个站点的域名验证状态、可见性与成员规模。')}</p>
          </div>
        </div>
        {loading ? (
          <PageLoading label={t('正在加载站点')} />
        ) : sites.length === 0 ? (
          <EmptyState
            icon="server"
            title={t('还没有站点')}
            body={t('新建站点后，它会立即出现在这里，并带有默认站点设计与第一位管理员。')}
            action={
              demo ? null : (
                <Link to="/admin/platform/new" className="btn btn-primary btn-sm">
                  {t('新建站点')}
                </Link>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('名称')}</th>
                  <th>{t('域名')}</th>
                  <th>{t('可见性')}</th>
                  <th>{t('发布模式')}</th>
                  <th className="cell-num">{t('成员')}</th>
                  <th className="cell-num">{t('管理员')}</th>
                  <th>{t('创建时间')}</th>
                  <th className="cell-actions">{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => {
                  const current = me?.site_id === site.id;
                  return (
                    <tr key={site.id}>
                      <td>
                        <div className="cell-title">
                          <Link to={`/admin/platform/${site.id}`}>{site.name}</Link>
                        </div>
                        <small className="muted">{site.slug}</small>
                      </td>
                      <td>
                        <div>{site.domain || '—'}</div>
                        <DomainBadge site={site} />
                      </td>
                      <td>
                        <Badge tone={site.visibility_mode === 'public' ? 'neutral' : 'accent'}>
                          {visibilityLabel(site.visibility_mode, t)}
                        </Badge>
                      </td>
                      <td>{publishLabel(site.publish_mode, t)}</td>
                      <td className="cell-num">{site.member_count}</td>
                      <td className="cell-num">{site.admin_count}</td>
                      <td>{formatDate(site.created_at)}</td>
                      <td className="cell-actions">
                        <Link to={`/admin/platform/${site.id}`} className="btn btn-ghost btn-sm">
                          {t('详情')}
                        </Link>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyId === site.id}
                          onClick={() => void enter(site)}
                        >
                          <Icon name="arrow-right" size={14} />
                          {busyId === site.id
                            ? t('正在进入…')
                            : current
                              ? t('返回本站后台')
                              : t('进入管理')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface CreateFormState {
  name: string;
  slug: string;
  description: string;
  domain: string;
  visibility_mode: PlatformSite['visibility_mode'];
  publish_mode: PlatformSite['publish_mode'];
  email: string;
  display_name: string;
  password: string;
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  slug: '',
  description: '',
  domain: '',
  visibility_mode: 'public',
  publish_mode: 'review',
  email: '',
  display_name: '',
  password: '',
};

/** 从站点名生成合法 slug；中文名生成空串，交由用户手填。 */
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function PlatformSiteNewPage() {
  const t = useT();
  useTitle(t('新建站点'));
  const backend = useBackend();
  const { me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const demo = isDemo(backend);
  const weakPassword = useWeakPasswordConfirm();

  if (me?.role !== 'platform_admin') {
    return <Forbidden need={t('平台管理员')} />;
  }

  const patch = (next: Partial<CreateFormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
  };

  const changeName = (name: string) => {
    setForm((prev) => ({
      ...prev,
      name,
      slug: slugTouched ? prev.slug : slugFromName(name),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await runSubmit(false);
  };

  const runSubmit = async (confirmWeak: boolean) => {
    if (busy) return;
    setError('');
    if (!form.name.trim()) return setError(t('请填写站点名称。'));
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(form.slug.trim())) {
      return setError(t('站点标识只能包含小写字母、数字与连字符。'));
    }
    if (!form.domain.trim()) return setError(t('请填写主域名，例如 press.example.com。'));
    if (!form.email.trim()) return setError(t('请填写初始管理员邮箱。'));
    if (!form.display_name.trim()) return setError(t('请填写初始管理员显示名。'));
    if (!form.password) return setError(t('请填写初始管理员密码。'));

    const weak = weakPasswordProblem(form.password);
    if (weak && !confirmWeak) {
      weakPassword.ask(weak, () => void runSubmit(true));
      return;
    }
    const hard = passwordCreationProblem(form.password, true);
    if (hard) return setError(t(passwordProblemText(hard, t)));

    setBusy(true);
    try {
      // 第二座站点会关掉“单站点无域名回退”。控制台所在站点如果没有已验证域名，
      // 新站点建成的瞬间当前入口就会消失，所以先在前端把前置条件讲清楚。
      if (me?.site_id) {
        const consoleSite = await backend.platformSite(me.site_id);
        if (!consoleSite.site.domain || !consoleSite.site.domain_verified) {
          setError(t('请先为当前站点配置并验证主域名，再创建其他站点，否则当前站点会失去访问入口。'));
          return;
        }
      }
      const created = await backend.createPlatformSite({
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description.trim(),
        domain: form.domain.trim(),
        visibility_mode: form.visibility_mode,
        publish_mode: form.publish_mode,
        owner: {
          email: form.email.trim(),
          display_name: form.display_name.trim(),
          password: form.password,
          confirm_weak_password: confirmWeak || undefined,
        },
      });
      toast.push('ok', t('站点已创建，默认设计已初始化。'), created.site.name);
      navigate(`/admin/platform/${created.site.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{t('新建站点')}</h1>
          <p>{t('站点创建后会生成默认站点设计，并创建第一位站点管理员。')}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/platform" className="btn btn-ghost btn-sm">
            <Icon name="arrow-left" size={14} /> {t('返回站点列表')}
          </Link>
        </div>
      </div>

      {demo ? (
        <Callout tone="warn" title={t('演示模式')}>
          {t('演示模式只运行一个站点，无法新建或跨站进入；连接真实后端后可用。')}
        </Callout>
      ) : null}

      <form className="panel panel-pad" onSubmit={(event) => void submit(event)}>
        <SectionHead
          title={t('站点信息')}
          description={t('名称与标识创建后仍可在站点设置里修改；主域名需要完成 TXT 归属验证。')}
        />
        <div className="form-grid">
          <Field label={t('站点名称')} htmlFor="platform-name">
            <Input
              id="platform-name"
              value={form.name}
              maxLength={160}
              onChange={(event) => changeName(event.target.value)}
              placeholder={t('例如：产品周刊')}
            />
          </Field>
          <Field
            label={t('站点标识（slug）')}
            hint={t('只允许小写字母、数字与连字符，用于 URL 与内部识别。')}
            htmlFor="platform-slug"
          >
            <Input
              id="platform-slug"
              value={form.slug}
              maxLength={64}
              onChange={(event) => {
                setSlugTouched(true);
                patch({ slug: event.target.value });
              }}
              placeholder="press-weekly"
            />
          </Field>
        </div>
        <Field
          label={t('站点简介')}
          hint={t('可留空，之后也能在站点设置里补充。')}
          htmlFor="platform-description"
        >
          <Input
            id="platform-description"
            value={form.description}
            maxLength={2000}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>
        <div className="form-grid">
          <Field
            label={t('主域名')}
            hint={t('必填。创建后需发布 DNS TXT 记录完成归属验证，验证前该域名不会提供站点。')}
            htmlFor="platform-domain"
          >
            <Input
              id="platform-domain"
              value={form.domain}
              maxLength={253}
              onChange={(event) => patch({ domain: event.target.value })}
              placeholder="press.example.com"
            />
          </Field>
          <Field label={t('站点可见性')} htmlFor="platform-visibility">
            <Select
              id="platform-visibility"
              value={form.visibility_mode}
              onChange={(event) =>
                patch({ visibility_mode: event.target.value as PlatformSite['visibility_mode'] })
              }
            >
              <option value="public">{t('公开：访客可以浏览')}</option>
              <option value="members_only">{t('仅成员：登录后可见')}</option>
            </Select>
          </Field>
        </div>
        <Field label={t('发布模式')} htmlFor="platform-publish">
          <Select
            id="platform-publish"
            value={form.publish_mode}
            onChange={(event) =>
              patch({ publish_mode: event.target.value as PlatformSite['publish_mode'] })
            }
          >
            <option value="review">{t('审核发布')}</option>
            <option value="open">{t('开放发布')}</option>
            <option value="role_based">{t('按角色发布')}</option>
          </Select>
        </Field>

        <SectionHead
          title={t('初始管理员')}
          description={t('这是新站点的第一位站点管理员，拥有该站点的全部管理权限。')}
        />
        <div className="form-grid">
          <Field label={t('管理员邮箱')} htmlFor="platform-owner-email">
            <Input
              id="platform-owner-email"
              type="email"
              autoComplete="off"
              value={form.email}
              onChange={(event) => patch({ email: event.target.value })}
            />
          </Field>
          <Field label={t('管理员显示名')} htmlFor="platform-owner-name">
            <Input
              id="platform-owner-name"
              value={form.display_name}
              maxLength={120}
              onChange={(event) => patch({ display_name: event.target.value })}
            />
          </Field>
        </div>
        <Field
          label={t('初始密码')}
          hint={t('建议至少 12 位并包含两类字符；弱密码确认后也可以保存。请通过安全渠道交给该管理员。')}
          htmlFor="platform-owner-password"
        >
          <Input
            id="platform-owner-password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => patch({ password: event.target.value })}
          />
        </Field>

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <Button type="submit" variant="primary" disabled={busy || demo}>
            {busy ? t('正在创建…') : t('创建站点')}
          </Button>
          <Link to="/admin/platform" className="btn btn-ghost btn-sm">
            {t('取消')}
          </Link>
        </div>
      </form>

      {weakPassword.dialog}
    </div>
  );
}

export function PlatformSiteDetailPage() {
  const t = useT();
  const { siteId = '' } = useParams<{ siteId: string }>();
  useTitle(t('站点详情'));
  const backend = useBackend();
  const { me } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const { data, error, loading, reload } = useAsync(
    () => backend.platformSite(siteId),
    [backend, siteId],
  );
  const entry = data;
  const site = entry?.site;

  if (me?.role !== 'platform_admin') {
    return <Forbidden need={t('平台管理员')} />;
  }
  if (loading) return <PageLoading label={t('正在加载站点')} />;
  if (error || !site) {
    return (
      <Callout tone="danger" title={t('加载站点失败')}>
        {error ? errorText(error) : t('站点不存在，或你无权查看。')}
      </Callout>
    );
  }

  const enter = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await backend.enterPlatformSite(site.id);
      if (!result.switchable) {
        toast.push('info', entryReasonText(result.reason, t));
        return;
      }
      if (me?.site_id === site.id) {
        navigate('/admin');
        return;
      }
      if (!result.switch_token || !site.domain) {
        toast.push('info', entryReasonText('domain_missing', t));
        return;
      }
      const url = new URL(adminEntryUrl(site.domain));
      url.hash = `pp_switch=${encodeURIComponent(result.switch_token)}`;
      window.location.assign(url.toString());
    } catch (err) {
      toast.push('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyDomain = async () => {
    if (verifying) return;
    setVerifying(true);
    try {
      const status = await backend.verifyPlatformSiteDomain(site.id);
      toast.push('ok', t('主域名已验证，可以进入该站点的管理后台。'), status.domain);
      reload();
    } catch (err) {
      toast.push('error', errorText(err));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{site.name}</h1>
          <p>{site.slug}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/platform" className="btn btn-ghost btn-sm">
            <Icon name="arrow-left" size={14} /> {t('返回站点列表')}
          </Link>
          <Button variant="primary" disabled={busy} onClick={() => void enter()}>
            <Icon name="arrow-right" size={14} />
            {busy ? t('正在进入…') : me?.site_id === site.id ? t('返回本站后台') : t('进入管理')}
          </Button>
        </div>
      </div>

      {!site.domain ? (
        <Callout tone="warn" title={t('无法进入')}>
          {t('该站点尚未绑定主域名，暂时无法进入。')}
        </Callout>
      ) : !site.domain_verified ? (
        <Callout tone="warn" title={t('主域名尚未验证')}>
          {t('请在目标站点的「站点设置 → 访问与域名」完成 TXT 验证后再进入。')}
        </Callout>
      ) : null}

      <div className="stat-grid">
        <div className="stat">
          <span>{t('成员数')}</span>
          <b>{site.member_count}</b>
        </div>
        <div className="stat">
          <span>{t('管理员数')}</span>
          <b>{site.admin_count}</b>
        </div>
        <div className="stat">
          <span>{t('站点状态')}</span>
          <b>{site.disabled ? t('已停用') : t('运行中')}</b>
        </div>
      </div>

      {site.domain && !site.domain_verified && entry ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('主域名归属验证')}</h3>
              <p>{t('请把下面的 TXT 记录添加到域名 DNS，然后点击「立即验证」。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('记录类型')}</span>
                <span className="mini-value mono">{entry.domain_status.record_type || 'TXT'}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('记录名')}</span>
                <span className="mini-value mono">{entry.domain_status.record_name}</span>
                <CopyButton value={entry.domain_status.record_name} />
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('记录值')}</span>
                <span className="mini-value mono">{entry.domain_status.verification_token}</span>
                <CopyButton value={entry.domain_status.verification_token} />
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <Button variant="primary" disabled={verifying} onClick={() => void verifyDomain()}>
                {verifying ? t('正在验证…') : t('立即验证')}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('站点信息')}</h3>
            <p>{t('来自平台接口的只读快照；修改站点设置请先进入该站点。')}</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr>
                <th>{t('标识')}</th>
                <td>{site.slug}</td>
              </tr>
              <tr>
                <th>{t('主域名')}</th>
                <td>
                  {site.domain || '—'} <DomainBadge site={site} />
                </td>
              </tr>
              <tr>
                <th>{t('可见性')}</th>
                <td>{visibilityLabel(site.visibility_mode, t)}</td>
              </tr>
              <tr>
                <th>{t('发布模式')}</th>
                <td>{publishLabel(site.publish_mode, t)}</td>
              </tr>
              <tr>
                <th>{t('站点简介')}</th>
                <td>{site.description || '—'}</td>
              </tr>
              <tr>
                <th>{t('创建时间')}</th>
                <td>{formatDate(site.created_at)}</td>
              </tr>
              <tr>
                <th>{t('最后更新')}</th>
                <td>{formatDate(site.updated_at)}</td>
              </tr>
              <tr>
                <th>{t('当前账户角色')}</th>
                <td>{entry?.role === 'platform_admin' ? t('平台管理员') : t('站点管理员')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
