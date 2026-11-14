import { useCallback, useEffect, useState } from 'react';
import type {
  PublishMode,
  Role,
  SiteKind,
  StepUpSettings,
  StepUpSettingsUpdate,
  VisibilityMode,
} from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { SITE_KIND_LABEL, siteKindOf } from '../../lib/site';
import { adminPathError, adminPathOf } from '../../lib/siteConfig';
import { useSaveSiteConfig } from '../../lib/siteConfigSave';
import { noteActivity } from '../../lib/activity';
import { useCustomization } from '../../lib/customize';
import { errorText, useT } from '../../lib/i18n';
import { parseMediaQuotaInput } from '../../lib/mediaQuota';
import {
  PUBLISH_LABEL,
  VISIBILITY_LABEL,
} from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useStepUp } from '../../lib/stepUp';
import { useToast } from '../../lib/toast';

export function SettingsPage() {
  const t = useT();
  const { site, me, config, applySite, updateConfig } = useAuth();
  const { customization, update: updateCustomization } = useCustomization();
  const backend = useBackend();
  const demo = isDemo(backend) ? backend : null;
  const toast = useToast();
  const [name, setName] = useState(site?.name ?? '');
  const [domain, setDomain] = useState(site?.domain ?? '');
  const [description, setDescription] = useState(site?.description ?? '');
  const [visibility, setVisibility] = useState<VisibilityMode>(site?.visibility_mode ?? 'public');
  const [publishMode, setPublishMode] = useState<PublishMode>(site?.publish_mode ?? 'review');
  /** O-3：站点是否开放自助注册；旧后端没有该字段时按开放处理。 */
  const [registrationOpen, setRegistrationOpen] = useState(site?.registration_open !== false);
  const [mediaQuotaDraft, setMediaQuotaDraft] = useState(
    site?.media_quota_bytes == null ? '' : String(site.media_quota_bytes),
  );
  const [kind, setKind] = useState<SiteKind>(siteKindOf(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [adminPath, setAdminPath] = useState(config.admin_path ?? '/admin');
  const saveSiteConfig = useSaveSiteConfig();
  const [resetOpen, setResetOpen] = useState(false);
  const [kindConfirmOpen, setKindConfirmOpen] = useState(false);
  const { ensureStepUp, applySettings: applyStepUpSettings } = useStepUp();
  /** 高威胁操作保护（step-up）的设置与表单状态。 */
  const [stepUpSettings, setStepUpSettings] = useState<StepUpSettings | null>(null);
  const [stepUpLoading, setStepUpLoading] = useState(true);
  const [stepUpError, setStepUpError] = useState('');
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState('');
  const [stepUpPasswordConfirm, setStepUpPasswordConfirm] = useState('');
  useTitle(t('站点设置'));

  useEffect(() => {
    if (!site) return;
    setName(site.name);
    setDomain(site.domain);
    setDescription(site.description ?? '');
    setVisibility(site.visibility_mode);
    setPublishMode(site.publish_mode);
    setRegistrationOpen(site.registration_open !== false);
    setMediaQuotaDraft(site.media_quota_bytes == null ? '' : String(site.media_quota_bytes));
    setDescriptionTouched(false);
  }, [site]);

  useEffect(() => {
    setKind(siteKindOf(config));
  }, [config]);

  const loadStepUpSettings = useCallback(async () => {
    if (!site) return;
    setStepUpLoading(true);
    setStepUpError('');
    try {
      const found = await backend.stepUpSettings(site.id);
      setStepUpSettings(found);
      applyStepUpSettings(found);
    } catch (err) {
      // 旧后端 / 后端未就绪：如实说明并允许重试，不阻塞页面上的其它设置。
      setStepUpSettings(null);
      setStepUpError(errorText(err));
    } finally {
      setStepUpLoading(false);
    }
  }, [applyStepUpSettings, backend, site]);

  useEffect(() => {
    void loadStepUpSettings();
  }, [loadStepUpSettings]);

  /**
   * 保存保护设置。
   *
   * 已启用或已设置专用密码之后再修改，服务端要求先通过二次验证，所以这里先
   * `ensureStepUp()`：取消或验证失败就什么也不写。返回值表示是否真的保存成功
   * （用于决定要不要清空密码输入框）。
   */
  const saveStepUp = async (patch: StepUpSettingsUpdate, action: string): Promise<boolean> => {
    if (!site) return false;
    // 设置未知时按“已配置”处理（fail-closed），不要让一次读失败绕过二次验证。
    const configured = stepUpSettings
      ? stepUpSettings.enabled || stepUpSettings.password_set
      : true;
    if (configured) {
      const ok = await ensureStepUp(action);
      if (!ok) return false;
    }
    setStepUpBusy(true);
    setStepUpError('');
    try {
      const updated = await backend.saveStepUpSettings(site.id, patch);
      setStepUpSettings(updated);
      applyStepUpSettings(updated);
      toast.push(
        'ok',
        t('高威胁操作保护已更新'),
        updated.enabled
          ? t('保护已开启：高危操作前会要求再次输入密码。')
          : t('保护已关闭：高危操作会直接执行。'),
      );
      return true;
    } catch (err) {
      const message = errorText(err);
      setStepUpError(message);
      toast.push('error', t('无法保存高威胁操作保护'), message);
      return false;
    } finally {
      setStepUpBusy(false);
    }
  };

  const saveStepUpPassword = async () => {
    if (!stepUpPassword) {
      setStepUpError(t('请填写专用安全密码。'));
      return;
    }
    if (stepUpPassword !== stepUpPasswordConfirm) {
      setStepUpError(t('两次输入的密码不一致。'));
      return;
    }
    const saved = await saveStepUp(
      { password: stepUpPassword },
      stepUpSettings?.password_set ? t('更换专用安全密码') : t('设置专用安全密码'),
    );
    if (saved) {
      setStepUpPassword('');
      setStepUpPasswordConfirm('');
    }
  };

  const clearStepUpPassword = async () => {
    const saved = await saveStepUp({ clear_password: true }, t('清除专用安全密码'));
    if (saved) {
      setStepUpPassword('');
      setStepUpPasswordConfirm('');
    }
  };

  const kindChanged = kind !== siteKindOf(config);
  const mediaQuota = parseMediaQuotaInput(mediaQuotaDraft);
  const dirty =
    !!site &&
    (name !== site.name ||
      domain !== site.domain ||
      description !== (site.description ?? '') ||
      visibility !== site.visibility_mode ||
      publishMode !== site.publish_mode ||
      registrationOpen !== (site.registration_open !== false) ||
      mediaQuotaDraft !== (site.media_quota_bytes == null ? '' : String(site.media_quota_bytes)) ||
      kindChanged ||
      adminPath !== (config.admin_path ?? '/admin'));

  const save = async () => {
    if (!me || !site) return;
    if (!name.trim()) {
      setError(t('站点名称不能为空。'));
      return;
    }
    if (!mediaQuota.valid) {
      setError(t('媒体额度必须是非负整数，且不能超过可存储上限。'));
      return;
    }
    const normalizedAdminPath = (adminPath.trim() || '/admin').replace(/\/+$/, '');
    // 与服务端同一套规则：提前拦住只会被拒绝的保存（占用站点路径、带查询参数等）。
    const pathIssue = adminPathError(normalizedAdminPath);
    if (pathIssue) {
      setError(pathIssue);
      return;
    }
    setAdminPath(normalizedAdminPath);
    if (kindChanged) {
      // 形态切换影响注册入口、登录策略与权限模型，先确认再落盘。
      setKindConfirmOpen(true);
      return;
    }
    await commit();
  };

  /**
   * 个人博客下所有账户都是最高权限：切过去时把成员提升为站点管理员，并记住原角色；
   * 切回社区站点时按快照恢复。服务端授权按角色执行，所以这一步也必须落到角色上。
   */
  const syncRoles = async (next: SiteKind) => {
    if (!site) return;
    try {
      if (next === 'personal') {
        const members = await backend.members(site.id);
        const snapshot: Record<string, Role> = { ...(config.role_snapshot ?? {}) };
        for (const member of members) {
          if (member.role === 'platform_admin' || member.role === 'site_admin') continue;
          snapshot[member.user_id] = member.role;
          await backend.setMemberRole(site.id, member.user_id, 'site_admin');
        }
        updateConfig({ role_snapshot: snapshot });
        return;
      }
      const snapshot = config.role_snapshot ?? {};
      for (const [userId, role] of Object.entries(snapshot)) {
        await backend.setMemberRole(site.id, userId, role as Role).catch(() => undefined);
      }
      updateConfig({ role_snapshot: undefined });
    } catch (err) {
      toast.push(
        'error',
        t('账户角色同步失败'),
        err instanceof Error ? err.message : t('请在「用户管理」里手动调整。'),
      );
    }
  };

  const commit = async () => {
    if (!me || !site) return;
    if (!mediaQuota.valid) {
      setError(t('媒体额度必须是非负整数，且不能超过可存储上限。'));
      return;
    }
    const normalizedAdminPath = (adminPath.trim() || '/admin').replace(/\/+$/, '');
    setError('');
    if (kindChanged) {
      // 切换站点形态会批量修改成员角色（服务端的受保护路由），先通过二次验证；
      // 取消或验证失败就什么都不提交。
      const ok = await ensureStepUp(t('切换站点形态'));
      if (!ok) return;
    }
    setBusy(true);
    // 个人博客固定公开阅读、直接发布：没有需要审核的其他成员。
    const nextVisibility: VisibilityMode = kind === 'personal' ? 'public' : visibility;
    const nextPublish: PublishMode = kind === 'personal' ? 'open' : publishMode;
    try {
      const sendDescription = site.description !== undefined || descriptionTouched;
      const trimmedDomain = domain.trim().toLowerCase();
      // 主域名单独走域名端点：它会同时写入 domain_verified_at，避免设置后站点 404。
      await backend.updateSite(site.id, {
        name: name.trim(),
        ...(sendDescription ? { description: description.trim() } : {}),
        visibility_mode: nextVisibility,
        publish_mode: nextPublish,
        // O-3：个人博客固定关闭注册，不把开关的旧值写回去。
        registration_open: kind === 'personal' ? false : registrationOpen,
        ...(mediaQuotaDraft !== (site.media_quota_bytes == null ? '' : String(site.media_quota_bytes))
          ? { media_quota_bytes: mediaQuota.value }
          : {}),
      });
      if (trimmedDomain !== site.domain) {
        await backend.setSiteDomain(site.id, trimmedDomain);
      }
      applySite({
        ...site,
        name: name.trim(),
        domain: trimmedDomain,
        ...(sendDescription ? { description: description.trim() } : {}),
        visibility_mode: nextVisibility,
        publish_mode: nextPublish,
        registration_open: kind === 'personal' ? false : registrationOpen,
        ...(mediaQuotaDraft !== (site.media_quota_bytes == null ? '' : String(site.media_quota_bytes))
          ? { media_quota_bytes: mediaQuota.value }
          : {}),
      });
      if (kindChanged) {
        updateConfig({ site_kind: kind });
        await syncRoles(kind);
      }
      // 后台入口进站点级配置：换设备、换浏览器都要从同一个地址进后台。保存成功后
      // 地址栏会立刻切到新入口，`/admin` 不再能进后台（见 lib/adminPathRoute.ts）。
      const adminPathSaved = await saveSiteConfig({
        admin_path: adminPathOf({ admin_path: normalizedAdminPath }),
      });
      if (!adminPathSaved) {
        setError(t('后台入口没有保存到服务端，仍在使用原来的入口。'));
        return;
      }
      setDescriptionTouched(false);
      noteActivity(
        backend,
        me.user.display_name,
        kindChanged ? '切换站点形态' : '修改站点设置',
        name.trim(),
        `${SITE_KIND_LABEL[kind]} · ${VISIBILITY_LABEL[nextVisibility]} · ${PUBLISH_LABEL[nextPublish]}`,
      );
      setKindConfirmOpen(false);
      toast.push(
        'ok',
        kindChanged ? t('站点形态已切换') : t('站点设置已保存'),
        kind === 'personal'
          ? t('个人博客模式已生效：注册入口关闭，所有账户都能登录后台。')
          : t('社区站点模式已生效：注册入口按「开放注册」开关生效，权限组按角色生效。'),
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : t('保存失败。');
      setError(text);
      toast.push('error', t('保存失败'), text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('站点设置')}</h1>
          <p>{t('左侧切换基本信息、访问与域名、SEO 与性能优化；登录方式与日志有独立入口。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" onClick={() => window.open('/', '_blank')} icon="eye">
            {t('预览站点')}
          </Button>
          <Button size="sm" loading={busy} disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mb-24">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      <div className={`settings-grid${demo ? '' : ' no-side'}`}>
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('基本信息')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <div className="form-grid">
                  <Field label={t('站点名称')} htmlFor="setting-name" aside={`${name.length}/160`}>
                    <Input
                      id="setting-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={160}
                    />
                  </Field>
                  <Field
                    label={t('访问域名')}
                    htmlFor="setting-domain"
                    hint={t(
                      '留空时生产环境只允许公网 IP 直接访问。SSL 证书与别名域名在「访问与域名」里配置；保存后需要在「访问与域名」完成 TXT 验证，验证前公网域名暂不生效。',
                    )}
                  >
                    <Input
                      id="setting-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label={t('站点简介')}
                  htmlFor="setting-description"
                  aside={`${description.length}/2000`}
                  hint={
                    site?.description === undefined
                      ? t('当前后端未返回简介；不修改时不会覆盖服务端已有的值。')
                      : t('显示在首页与页脚。首页大标题在「外观 → 首页首屏」修改。')
                  }
                >
                  <Textarea
                    id="setting-description"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setDescriptionTouched(true);
                    }}
                    maxLength={2000}
                    style={{ minHeight: 96 }}
                  />
                </Field>
                <Field
                  label={t('站点图标')}
                  htmlFor="setting-site-icon"
                  hint={t('浏览器标签页与收藏夹图标（favicon），填 http(s) 或站内绝对路径，建议 32×32 / 64×64。留空使用内置图标。')}
                >
                  <div className="row gap-8">
                    <Input
                      id="setting-site-icon"
                      value={customization.layout.site_icon ?? ''}
                      onChange={(event) =>
                        updateCustomization({
                          layout: { ...customization.layout, site_icon: event.target.value },
                        })
                      }
                      placeholder="https://…/icon.png"
                      maxLength={500}
                    />
                    {customization.layout.site_icon ? (
                      <img
                        className="setting-site-icon-preview"
                        src={customization.layout.site_icon}
                        alt={t('站点图标预览')}
                        width={30}
                        height={30}
                      />
                    ) : null}
                  </div>
                </Field>
                <Field
                  label={t('后台入口地址')}
                  htmlFor="setting-admin-path"
                  hint={t(
                    '自定义后台登录入口路径，例如 /manage。保存后地址栏会立刻改到这个入口，所有访客与设备都从它进后台；原来的 /admin 不再能进入后台。',
                  )}
                >
                  <Input
                    id="setting-admin-path"
                    value={adminPath}
                    onChange={(event) => setAdminPath(event.target.value)}
                    placeholder="/admin"
                    maxLength={80}
                  />
                </Field>
                <Toggle
                  checked={customization.layout.show_filing}
                  onChange={(next) =>
                    updateCustomization({
                      layout: { ...customization.layout, show_filing: next },
                    })
                  }
                  label={t('在页脚展示中国内地备案信息')}
                  description={t('面向中国大陆用户时开启；海外站点可以保持关闭，页脚会隐藏 ICP 备案号与公安网备。')}
                />
                {customization.layout.show_filing ? (
                  <>
                    <div className="form-grid">
                      <Field
                        label={t('ICP 备案号')}
                        htmlFor="setting-icp"
                        hint={t('显示在页脚并链接到工信部备案系统。')}
                      >
                        <Input
                          id="setting-icp"
                          value={customization.layout.icp}
                          onChange={(event) =>
                            updateCustomization({
                              layout: { ...customization.layout, icp: event.target.value },
                            })
                          }
                          placeholder={t('例如：京 ICP 备 00000000 号')}
                          maxLength={80}
                        />
                      </Field>
                      <Field
                        label={t('公安网备号')}
                        htmlFor="setting-police"
                        hint={t('显示在页脚并链接到全国互联网安全管理服务平台。')}
                      >
                        <Input
                          id="setting-police"
                          value={customization.layout.police}
                          onChange={(event) =>
                            updateCustomization({
                              layout: { ...customization.layout, police: event.target.value },
                            })
                          }
                          placeholder={t('例如：京公网安备 11010502030123 号')}
                          maxLength={80}
                        />
                      </Field>
                    </div>
                    <Field
                      label={t('公安网备图标')}
                      htmlFor="setting-police-icon"
                      hint={t('填写图标 URL；留空使用内置盾牌图标。')}
                    >
                      <Input
                        id="setting-police-icon"
                        value={customization.layout.police_icon ?? ''}
                        onChange={(event) =>
                          updateCustomization({
                            layout: { ...customization.layout, police_icon: event.target.value },
                          })
                        }
                        placeholder="https://…/badge.png"
                        maxLength={500}
                      />
                    </Field>
                  </>
                ) : null}
                <Field label={t('站点路径（slug）')} hint={t('创建站点时生成，不能在此修改。')}>
                  <Input value={site?.slug ?? ''} readOnly disabled />
                </Field>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('媒体额度')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <Field
                label={t('本站媒体额度（字节）')}
                htmlFor="setting-media-quota"
                hint={t('留空表示继承部署默认，0 表示无限；正整数按字节计算。')}
              >
                <Input
                  id="setting-media-quota"
                  aria-label={t('本站媒体额度（字节）')}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={mediaQuotaDraft}
                  onChange={(event) => setMediaQuotaDraft(event.target.value)}
                />
              </Field>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('站点形态')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="option-grid two">
                {(['personal', 'community'] as const).map((option) => (
                  <label key={option} className={`option${kind === option ? ' is-selected' : ''}`}>
                    <span className="option-icon">
                      <Icon name={option === 'personal' ? 'user' : 'users'} size={16} />
                    </span>
                    <span className="option-body">
                      <strong>{SITE_KIND_LABEL[option]}</strong>
                      <p>
                        {option === 'personal'
                          ? t('关闭自助注册。站长可以创建账户，所有账户都能登录后台并拥有最高权限。')
                          : t('访客可以自助注册，登录后评论、收藏与投稿；权限按权限组划分。')}
                      </p>
                    </span>
                    <input
                      type="radio"
                      name="site-kind"
                      checked={kind === option}
                      onChange={() => {
                        setKind(option);
                        if (option === 'personal') {
                          setVisibility('public');
                          setPublishMode('open');
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
              {kind === 'personal' ? (
                <Callout tone="info" icon="user" title={t('个人博客：注册关闭，账户由站长创建')}>
                  {t('保存后前台不再显示注册入口，注册页关闭；已有账户、文章与评论全部保留，可以继续登录。')}{' '}
                  {t('个人博客下所有账户都能进入后台并拥有最高权限，可以在「用户管理」里创建账户。')}{' '}
                  {t('注册接口会直接拒绝新的自助注册（403 registration_closed），不需要再改网关配置。')}
                </Callout>
              ) : (
                <Callout tone="info" icon="users" title={t('社区站点：自助注册与用户组')}>
                  {t('访客可以自助注册成为成员；成员、审核员、管理员与最高管理员的能力可以在「用户组」里逐项调整。')}{' '}
                  {t('从个人博客切回社区站点时，之前创建的账户会恢复各自用户组，文章与评论不受影响。')}
                </Callout>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('注册与账户')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <Toggle
                checked={kind === 'community' && registrationOpen}
                disabled={kind === 'personal'}
                onChange={setRegistrationOpen}
                label={t('开放注册')}
                description={t(
                  '关闭后前台与注册页都不再显示注册入口；已注册账户的登录与使用不受影响。',
                )}
              />
              {kind === 'personal' ? (
                <Callout tone="info" icon="user" title={t('个人博客固定关闭注册')}>
                  {t('个人博客没有自助注册；需要账户时请到「用户管理」创建。切回社区站点后可以重新打开。')}
                </Callout>
              ) : !registrationOpen ? (
                <Callout tone="warn" icon="lock" title={t('注册已关闭')}>
                  {t('访客在注册页会看到「本站暂未开放注册」；新成员只能由管理员在「用户管理」里创建或邀请。')}
                </Callout>
              ) : null}
            </div>
          </section>

          {kind === 'community' ? (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('访客模式')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="option-grid two">
                {(['public', 'members_only'] as const).map((mode) => (
                  <label key={mode} className={`option${visibility === mode ? ' is-selected' : ''}`}>
                    <span className="option-icon">
                      <Icon name={mode === 'public' ? 'globe' : 'lock'} size={16} />
                    </span>
                    <span className="option-body">
                      <strong>{VISIBILITY_LABEL[mode]}</strong>
                      <p>
                        {mode === 'public'
                          ? t('未登录访客可以读已发布内容，匿名请求按站点解析。')
                          : t('所有内容都要求登录；匿名请求返回 401。')}
                      </p>
                    </span>
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === mode}
                      onChange={() => setVisibility(mode)}
                    />
                  </label>
                ))}
              </div>
            </div>
          </section>
          ) : null}

          {kind === 'community' ? (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('发布模式')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="option-grid three">
                {(['open', 'review', 'role_based'] as const).map((mode) => (
                  <label key={mode} className={`setting-option${publishMode === mode ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="publish-mode-setting"
                      checked={publishMode === mode}
                      onChange={() => setPublishMode(mode)}
                    />
                    <span>
                      <strong>{PUBLISH_LABEL[mode]}</strong>
                      <p>
                        {mode === 'open'
                          ? t('成员可以从草稿直接发布，不再进入审核队列。')
                          : mode === 'review'
                            ? t('所有成员（包括编辑）的稿件都需要另一位编辑审核。')
                            : t('普通成员需要审核；编辑与管理员可以直接发布。')}
                      </p>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>
          ) : (
            <Callout tone="info" icon="user" title={t('固定的阅读与发布规则')}>
              {t('个人博客固定为公开阅读与直接发布：没有其他成员，也没有需要审核的稿件。')}
            </Callout>
          )}

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('高威胁操作保护')}</h3>
                <p>{t('删除用户、修改别人的账户、覆盖导入等重要操作前，需要再输入一次密码；同一次浏览器会话内只验证一次。')}</p>
              </div>
            </div>
            <div className="panel-body">
              {stepUpLoading ? (
                <p className="stepup-status-note">{t('正在读取保护设置…')}</p>
              ) : null}
              {stepUpError ? (
                <div className="mb-16">
                  <Callout tone="danger" icon="alert" title={t('无法读取或保存保护设置')}>
                    {stepUpError}
                  </Callout>
                  <Button
                    className="mt-12"
                    variant="secondary"
                    size="sm"
                    icon="refresh"
                    onClick={() => void loadStepUpSettings()}
                  >
                    {t('重新读取')}
                  </Button>
                </div>
              ) : null}
              {stepUpSettings ? (
                <>
                  <div className="stepup-status">
                    <Badge tone={stepUpSettings.enabled ? 'ok' : 'muted'} dot>
                      {stepUpSettings.enabled ? t('已开启') : t('已关闭')}
                    </Badge>
                    <span className="stepup-status-note">
                      {t('本次浏览器会话内有效；关闭浏览器后重新验证')}
                    </span>
                    <span className="stepup-status-note">
                      {stepUpSettings.password_set
                        ? t('已设置专用安全密码')
                        : t('验证使用账户登录密码')}
                    </span>
                  </div>
                  <Toggle
                    checked={stepUpSettings.enabled}
                    disabled={stepUpBusy}
                    onChange={(next) =>
                      void saveStepUp(
                        { enabled: next },
                        next ? t('开启高威胁操作保护') : t('关闭高威胁操作保护'),
                      )
                    }
                    label={t('开启高威胁操作保护')}
                    description={t('开启后，删除账户、修改其他成员、覆盖导入等操作前会要求再次输入密码；关闭后这些操作直接执行。')}
                  />
                  {demo ? (
                    <Callout tone="info" icon="info" title={t('演示模式不校验二次密码')}>
                      {t('演示模式没有服务端安全校验：开关会保存在本地，高危操作会直接执行；专用密码不可用。连接真实后端后才会真正校验。')}
                    </Callout>
                  ) : stepUpSettings.enabled ? (
                    <div className="form-stack mt-16">
                      <Field
                        label={t('专用安全密码（可选）')}
                        htmlFor="stepup-password-new"
                        hint={t('留空表示不修改。设置后验证只接受这个专用密码；清除后恢复使用账户登录密码。至少 8 位。')}
                      >
                        <Input
                          id="stepup-password-new"
                          type="password"
                          autoComplete="new-password"
                          value={stepUpPassword}
                          onChange={(event) => {
                            setStepUpPassword(event.target.value);
                            if (stepUpError) setStepUpError('');
                          }}
                        />
                      </Field>
                      <Field label={t('确认专用安全密码')} htmlFor="stepup-password-confirm">
                        <Input
                          id="stepup-password-confirm"
                          type="password"
                          autoComplete="new-password"
                          value={stepUpPasswordConfirm}
                          onChange={(event) => {
                            setStepUpPasswordConfirm(event.target.value);
                            if (stepUpError) setStepUpError('');
                          }}
                        />
                      </Field>
                      <div className="row gap-8">
                        <Button
                          size="sm"
                          icon="lock"
                          loading={stepUpBusy}
                          onClick={() => void saveStepUpPassword()}
                        >
                          {stepUpSettings.password_set ? t('更换专用密码') : t('设置专用密码')}
                        </Button>
                        {stepUpSettings.password_set ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={stepUpBusy}
                            onClick={() => void clearStepUpPassword()}
                          >
                            {t('清除专用密码')}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>

          <div className="row gap-8">
            <Button loading={busy} disabled={!dirty} onClick={save} icon="check">
              {t('保存修改')}
            </Button>
            {dirty ? (
              <Button
                variant="ghost"
                onClick={() => {
                  if (!site) return;
                  setName(site.name);
                  setDomain(site.domain);
                  setDescription(site.description ?? '');
                  setVisibility(site.visibility_mode);
                  setPublishMode(site.publish_mode);
                  setRegistrationOpen(site.registration_open !== false);
                  setKind(siteKindOf(config));
                  setAdminPath(config.admin_path ?? '/admin');
                  setError('');
                }}
              >
                {t('放弃未保存的修改')}
              </Button>
            ) : (
              <span className="tiny faint">{t('没有未保存的修改')}</span>
            )}
          </div>

        </div>

        <aside className="settings-side">
          {demo ? (
            <div className="danger-zone">
              <h3>{t('演示数据')}</h3>
              <p>{t('清空浏览器里的示例文章、评论、成员与上传记录，并重新载入安装流程。')}</p>
              <Button variant="danger" size="sm" className="mt-12" icon="trash" onClick={() => setResetOpen(true)}>
                {t('重置演示数据')}
              </Button>
            </div>
          ) : null}
        </aside>
      </div>

      <Modal
        open={kindConfirmOpen}
        title={kind === 'personal' ? t('切换到个人博客？') : t('切换到社区站点？')}
        description={
          kind === 'personal'
            ? t('注册入口会关闭，所有账户获得后台最高权限。')
            : t('注册入口重新开放，权限组按角色生效。')
        }
        onClose={() => setKindConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setKindConfirmOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={busy} onClick={() => void commit()} icon="check">
              {t('确认切换')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Callout tone="info" icon="database" title={t('数据不会丢失')}>
            {t('账户、文章、评论、媒体与页面全部保留。切换只改变注册入口、登录策略与权限模型，')}{' '}
            {t('不会删除或重建任何数据。')}
          </Callout>
          {kind === 'personal' ? (
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('已有账户')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('全部保留，并且都能登录后台；在个人博客下统一按最高管理员处理。')}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('角色记录')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('原角色原样保存，切回社区站点后自动恢复。')}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('阅读与发布')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('固定为公开阅读与直接发布，避免出现无人可审的稿件。')}
                </span>
              </div>
            </div>
          ) : (
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('已有账户')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('全部保留，并按各自角色回到成员、审核员、管理员或最高管理员组。')}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('注册')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('前台重新显示注册入口；新账户默认是普通成员。')}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('权限组')}</span>
                <span className="mini-value" style={{ textAlign: 'left', fontWeight: 400 }}>
                  {t('可以在「权限组」里逐项调整五组能力。')}
                </span>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={resetOpen}
        title={t('重置演示数据？')}
        description={t('所有本地文章、评论、成员、通知与上传记录都会被清空。')}
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="danger" onClick={() => demo?.reset()}>
              {t('清空并重新开始')}
            </Button>
          </>
        }
      >
        <Callout tone="danger" icon="alert" title={t('这个操作不可撤销')}>
          {t('演示数据只存在这台电脑的浏览器里。重置前请确认没有需要保留的草稿。')}
        </Callout>
      </Modal>
    </RoleGate>
  );
}
