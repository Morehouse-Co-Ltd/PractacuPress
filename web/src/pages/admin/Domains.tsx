import { useEffect, useMemo, useRef, useState } from 'react';
import type { DomainSettings, EffectiveConfig, SiteDomainVerification } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import {
  boundDomains,
  DEFAULT_DOMAINS,
  domainAllowed,
  domainEntryError,
  domainVerificationErrorReason,
  isDomainPendingVerification,
  isIpHost,
  isLocalHost,
  isPublicIp,
  normalizeDomain,
  normalizeOrigin,
  readDomains,
} from '../../lib/domains';
import { readAccess } from '../../lib/access';
import {
  buildDomainEnvSnippet,
  buildGatewaySnippet,
  buildTlsSetupSnippet,
} from '../../lib/serverConfig';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useSaveSiteConfig } from '../../lib/siteConfigSave';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Skeleton,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { AutoSaveStatus, type AutoSaveState } from '../../components/AutoSaveStatus';
import { RoleGate } from '../../components/Guards';

/** 自动保存的防抖间隔：停下编辑这么久才写服务端，避免每敲一下都发一次 PUT。 */
const AUTOSAVE_DELAY_MS = 700;

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 页面里参与保存的几块表单内容；自动保存的签名与逐条校验都基于这份快照。 */
interface DomainsForm {
  draft: DomainSettings;
  primaryText: string;
  aliasText: string;
  originText: string;
  proxyText: string;
}

/**
 * 把表单收敛成将要保存的域名配置。
 *
 * 自动保存靠它做「有没有变化」的比较：归一化后签名相同就不发请求；真正写下去的
 * 也是这份对象，页面看到的与保存的不会分叉。
 */
function domainsPayloadOf(form: DomainsForm): DomainSettings {
  const primary = normalizeDomain(form.primaryText);
  return readDomains({
    domains: {
      ...form.draft,
      primary: primary || form.draft.primary,
      aliases: linesOf(form.aliasText),
      cors_origins: linesOf(form.originText),
      trusted_proxies: linesOf(form.proxyText),
      tls: { ...form.draft.tls, email: form.draft.tls.email.trim() },
    },
  });
}

export function DomainsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  useTitle(embedded ? t('访问与域名') : t('域名绑定'));
  const { config, site, me, applySite } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saveSiteConfig = useSaveSiteConfig();

  /**
   * 服务端真正生效的跨域与域名设置。
   *
   * 本页保存的值只进入生成的 .env，API 进程读的是它启动时的环境变量；把「记录值」
   * 和「生效值」并排展示，才不会让用户以为改完开关就已生效。旧后端没有这个端点时
   * 返回 null，页面其余部分照旧可用。
   */
  const effective = useAsync<EffectiveConfig | null>(async () => {
    if (typeof backend.effectiveConfig !== 'function') return null;
    return backend.effectiveConfig();
  }, [backend]);
  const saved = useMemo(() => readDomains(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<DomainSettings>(() => saved);
  const [aliasText, setAliasText] = useState('');
  const [originText, setOriginText] = useState('');
  const [proxyText, setProxyText] = useState('');
  const [primaryText, setPrimaryText] = useState(() => site?.domain || saved.primary);
  const [errors, setErrors] = useState<string[]>([]);
  /** V-12：主域名归属验证状态；旧后端没有该端点时保持 null，退回原来的展示。 */
  const [domainCheck, setDomainCheck] = useState<SiteDomainVerification | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const access = useMemo(() => readAccess(config), [config]);
  const primary = site?.domain || saved.primary;
  const primaryDomain = normalizeDomain(primaryText);
  const domainPending = isDomainPendingVerification(domainCheck, primaryDomain);
  const domainVerified =
    !!primaryDomain &&
    domainCheck?.verified === true &&
    domainCheck.domain.trim().toLowerCase() === primaryDomain.toLowerCase();
  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  const currentAllowed = domainAllowed(host, saved, primary);
  const localExempt = saved.allow_localhost && isLocalHost(host);
  const ipExempt = saved.allow_ip && isIpHost(host);
  const hostIsPublicIp = isPublicIp(host);
  const allowed = boundDomains(saved, primary);
  /** 自动保存状态：设置改成自动保存后，这是站长确认改动真的落地的唯一入口。 */
  const [saveState, setSaveState] = useState<AutoSaveState>('idle');
  const [saveError, setSaveError] = useState('');
  /**
   * 最近一次写入服务端的载荷签名。
   *
   * 初值就是首屏那份配置：挂载时表单与配置一致、签名相同，自动保存不会在打开页面
   * 时白写一次。之后成功的保存、配置回填与「恢复默认」都会更新它。
   */
  const initialForm: DomainsForm = {
    draft: saved,
    primaryText: site?.domain || saved.primary,
    aliasText: saved.aliases.join('\n'),
    originText: saved.cors_origins.join('\n'),
    proxyText: saved.trusted_proxies.join('\n'),
  };
  const lastSavedRef = useRef(JSON.stringify(domainsPayloadOf(initialForm)));
  /** 表单快照：自动保存的定时器与队列任务都从这里读最新输入，避免拿到旧闭包。 */
  const formRef = useRef<DomainsForm>({
    draft,
    primaryText,
    aliasText,
    originText,
    proxyText,
  });
  formRef.current = { draft, primaryText, aliasText, originText, proxyText };
  /**
   * 表单与最近一次写入/回填的内容是否不同。
   *
   * 用「上次保存的基线」而不是「当前配置」判断：站点与配置会在挂载后再水合一次，
   * 若拿未变的表单去比新配置，会被误判成「有未保存修改」而拒绝回填。
   */
  const formSignature = JSON.stringify(domainsPayloadOf(formRef.current));
  const dirty = formSignature !== lastSavedRef.current;
  /** 有没有更新的本地编辑；配置回填时据此决定要不要覆盖输入。 */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** 串行队列：同一时间只允许一笔保存在途，避免后发请求被前一笔覆盖。 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  /** 一次性把整份表单写进渲染状态与快照，异步保存回调用它收敛草稿。 */
  const applyForm = (next: DomainsForm) => {
    formRef.current = next;
    setDraft(next.draft);
    setPrimaryText(next.primaryText);
    setAliasText(next.aliasText);
    setOriginText(next.originText);
    setProxyText(next.proxyText);
  };

  // 保存后跟着配置收敛一次，避免草稿与真正生效的域名配置分叉。
  // 只在没有更新的本地编辑时回填：否则保存响应会把用户刚敲进去的内容冲掉。
  useEffect(() => {
    const next = readDomains(config);
    const nextForm: DomainsForm = {
      draft: next,
      primaryText: site?.domain || next.primary,
      aliasText: next.aliases.join('\n'),
      originText: next.cors_origins.join('\n'),
      proxyText: next.trusted_proxies.join('\n'),
    };
    if (dirtyRef.current) return;
    lastSavedRef.current = JSON.stringify(domainsPayloadOf(nextForm));
    applyForm(nextForm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, site?.domain]);

  /** 串行写：自动保存与「恢复默认」都排队，保证最后一次操作真正落库。 */
  const queueSave = (task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task).catch(() => {});
  };

  // V-12：保存域名后服务端进入「待验证」，验证状态（TXT 记录名/值）需要单独读取。
  // 旧后端没有这个端点：静默降级，页面照旧显示域名输入。
  const reloadDomainCheck = async (siteId: string): Promise<void> => {
    try {
      setDomainCheck(await backend.siteDomain(siteId));
    } catch {
      setDomainCheck(null);
    }
  };

  useEffect(() => {
    if (!site) return;
    let alive = true;
    void backend
      .siteDomain(site.id)
      .then((check) => {
        if (alive) setDomainCheck(check);
      })
      .catch(() => {
        if (alive) setDomainCheck(null);
      });
    return () => {
      alive = false;
    };
  }, [backend, site?.id]);

  /** 保存前的逐条校验；自动保存只有在全部通过后才发请求。 */
  const validateForm = (form: DomainsForm): string[] => {
    const aliasProblems = linesOf(form.aliasText)
      .map((item) => domainEntryError(item))
      .filter(Boolean);
    const originProblems = linesOf(form.originText)
      .map((item) => normalizeOrigin(item))
      .filter((item) => !item)
      .map(() => t('CORS 来源必须是以 http(s) 开头的地址。'));
    const problems = [...aliasProblems, ...originProblems];
    const normalizedPrimary = normalizeDomain(form.primaryText);
    if (form.primaryText.trim() && !normalizedPrimary) {
      problems.push(t('主域名不是有效域名。'));
    }
    if (normalizedPrimary && (isIpHost(normalizedPrimary) || normalizedPrimary.startsWith('*.'))) {
      problems.push(t('主域名必须是具体域名，不能是 IP 或通配符。'));
    }
    if (form.draft.tls.mode === 'letsencrypt') {
      if (!normalizedPrimary) problems.push(t("Let's Encrypt 需要先填写主域名。"));
      if (!form.draft.tls.email.trim()) problems.push(t("Let's Encrypt 需要一个通知邮箱。"));
    }
    if (form.draft.tls.mode === 'manual') {
      if (!form.draft.tls.cert_path.trim() || !form.draft.tls.key_path.trim()) {
        problems.push(t('手动证书需要填写证书链与私钥的服务器路径。'));
      }
    }
    return problems;
  };

  /** 自动保存：校验通过后写主域名与整份域名配置，成功再提示并记录动态。 */
  const autosave = () => {
    queueSave(async () => {
      const form = formRef.current;
      const problems = validateForm(form);
      if (problems.length) {
        // 有非法值就不发请求：逐条错误留在页面上，状态条也停在明确的错误态。
        setErrors(problems);
        setSaveError(problems[0]);
        setSaveState('error');
        return;
      }
      const payload = domainsPayloadOf(form);
      const signature = JSON.stringify(payload);
      // 排队期间草稿可能已经保存过（或被回填成同一份）：不重复写。
      if (signature === lastSavedRef.current) {
        setSaveState((prev) => (prev === 'pending' ? 'idle' : prev));
        return;
      }
      setErrors([]);
      setSaveError('');
      setSaveState('saving');
      const normalizedPrimary = normalizeDomain(form.primaryText);
      try {
        if (normalizedPrimary !== primary && site) {
          await backend.setSiteDomain(site.id, normalizedPrimary);
          applySite({ ...site, domain: normalizedPrimary });
          setVerifyError('');
          // 保存后进入「待验证」：刷新 TXT 记录信息，让站长能直接完成验证。
          await reloadDomainCheck(site.id);
        }
        // 域名白名单是站点级配置：写服务端，访客才读得到（本机 localStorage 只做首屏缓存）。
        const ok = await saveSiteConfig({ domains: payload });
        // 失败时本地配置已经被乐观更新：基线跟着走到这份载荷，避免自动重试风暴。
        lastSavedRef.current = signature;
        if (!ok) {
          const message = t('配置没有保存到服务端，请稍后重试。');
          setErrors([message]);
          setSaveError(message);
          setSaveState('error');
          return;
        }
        // 保存期间可能又改过：只有没有更新的编辑时才把表单收敛成标准写法。
        if (JSON.stringify(domainsPayloadOf(formRef.current)) === signature) {
          applyForm({
            draft: payload,
            primaryText: normalizedPrimary,
            aliasText: payload.aliases.join('\n'),
            originText: payload.cors_origins.join('\n'),
            proxyText: payload.trusted_proxies.join('\n'),
          });
          setSaveState('saved');
        } else {
          setSaveState('pending');
        }
        toast.push('ok', t('已自动保存'));
        if (me) {
          noteActivity(
            backend,
            me.user.display_name,
            '修改访问与域名',
            normalizedPrimary || '未设置域名',
            `${payload.aliases.length} 个别名 · TLS ${payload.tls.mode}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t('保存失败。');
        setErrors([message]);
        setSaveError(message);
        setSaveState('error');
        toast.push('error', t('无法保存主域名'), message);
      }
    });
  };

  // 停下编辑 700ms 后自动保存；签名与上次写入一致说明只是回填/重复渲染，不发请求。
  useEffect(() => {
    const form = formRef.current;
    const signature = JSON.stringify(domainsPayloadOf(form));
    const problems = validateForm(form);
    if (!problems.length && signature === lastSavedRef.current) {
      // 用回已保存的内容时清掉旧错误：pending / error 都收回 idle，「已保存」保留。
      setSaveState((prev) => (prev === 'pending' || prev === 'error' ? 'idle' : prev));
      setErrors((prev) => (prev.length ? [] : prev));
      setSaveError((prev) => (prev ? '' : prev));
      return;
    }
    setSaveState('pending');
    const timer = window.setTimeout(autosave, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, primaryText, aliasText, originText, proxyText]);

  /** 队列/定时器里的最新保存函数；卸载时用它补写，避免 700ms 内切走丢掉修改。 */
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  useEffect(() => {
    return () => {
      if (dirtyRef.current) autosaveRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 立即验证主域名：成功后刷新状态并提示；失败按 reason 映射成可读文案。 */
  const runDomainVerify = async () => {
    if (!site) return;
    setVerifyError('');
    setVerifyBusy(true);
    try {
      const result = await backend.verifySiteDomain(site.id);
      await reloadDomainCheck(site.id);
      if (result.verified) {
        toast.push('ok', t('域名验证成功'), t('公网域名已经生效。'));
      } else {
        setVerifyError(t('还没有验证通过，请稍后重试。'));
      }
    } catch (err) {
      const reason = domainVerificationErrorReason(err);
      setVerifyError(
        reason === 'dns_not_found'
          ? t('还没有查询到 TXT 记录。DNS 生效可能需要几分钟，请稍后重试。')
          : reason === 'validation_failed'
            ? t('域名状态不允许验证，请检查域名格式与保存状态。')
            : err instanceof Error
              ? err.message
              : t('验证失败，请稍后重试。'),
      );
    } finally {
      setVerifyBusy(false);
    }
  };

  const reset = async () => {
    queueSave(async () => {
      const resetForm: DomainsForm = {
        draft: DEFAULT_DOMAINS,
        primaryText: site?.domain || '',
        aliasText: '',
        originText: '',
        proxyText: '',
      };
      // 恢复默认是一次显式写入：先把它设成基线，排队中的旧草稿不会再覆盖回去。
      lastSavedRef.current = JSON.stringify(domainsPayloadOf(resetForm));
      const ok = await saveSiteConfig({ domains: DEFAULT_DOMAINS });
      applyForm(resetForm);
      setErrors([]);
      setSaveError('');
      if (!ok) {
        setSaveState('error');
        return;
      }
      setSaveState('saved');
      toast.push('ok', t('已恢复默认域名设置'), t('白名单关闭，localhost 与 IP 默认允许。'));
    });
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className={embedded ? 'admin-page-head embedded-section-head' : 'admin-page-head'}>
        <div>
          {embedded ? <h2>{t('域名绑定')}</h2> : <h1>{t('访问与域名')}</h1>}
          <p>
            {t('设置站点主域名、别名白名单、SSL 证书、CORS 来源与反向代理信任地址，并生成 Nginx 与 API 环境变量片段。没有设置主域名时，生产环境只允许公网 IP 直接访问。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <AutoSaveStatus state={saveState} error={saveError} />
        </div>
      </div>

      {errors.length ? (
        <Callout tone="danger" icon="alert" title={t('有设置没有通过校验')}>
          <ul className="domain-error-list">
            {errors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {!primaryText.trim() ? (
        <Callout tone="warn" icon="globe" title={t('未设置主域名：只允许公网 IP 直接访问')}>
          {t('填写域名并配置 DNS 后，站点会按域名与证书对外服务；不填时，生产环境只接受公网 IP 的 Host， 私有 IP 与普通域名都不解析。本机管理仍可通过 localhost 访问。')}
        </Callout>
      ) : null}

      <Callout tone="info" icon="globe" title={t('别名域名需要网关把 Host 改写为主域名')}>
        {t('服务端按 Host 解析站点，别名域名直连 API 会被当成未知站点。下方 Nginx 片段里已经包含')}
        <code className="mono"> {t('proxy_set_header Host 主域名;')}</code>
        {t('，请一并部署。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('主域名')}</h3>
                <p>{t('修改会自动写入站点配置；留空表示不设置域名（生产环境回退到公网 IP 直连）。')}</p>
              </div>
              <Badge
                tone={
                  !primaryText.trim() ? 'warn' : domainPending ? 'warn' : domainVerified ? 'ok' : 'accent'
                }
              >
                {!primaryText.trim()
                  ? t('未设置（公网 IP）')
                  : domainPending
                    ? t('待验证')
                    : domainVerified
                      ? t('已验证')
                      : primaryText.trim()}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <Field
                  label={t('主域名')}
                  htmlFor="domains-primary"
                  hint={t('只填主机名，例如 press.example.com；不要带 https://、路径或端口。')}
                >
                  <Input
                    id="domains-primary"
                    value={primaryText}
                    onChange={(event) => setPrimaryText(event.target.value)}
                    placeholder="press.example.com"
                    maxLength={253}
                  />
                </Field>
                <Field label={t('当前访问域名')} hint={t('浏览器实际打开的 host。')}>
                  <div className="row gap-8">
                    <Input value={host} readOnly disabled />
                    <Badge tone={currentAllowed ? 'ok' : 'danger'}>
                      {currentAllowed
                        ? localExempt
                          ? t('本地豁免')
                          : ipExempt
                            ? t('IP 放行')
                            : hostIsPublicIp
                              ? t('公网 IP')
                              : t('已绑定')
                        : t('未绑定')}
                    </Badge>
                  </div>
                </Field>
              </div>

              {primaryDomain && domainPending && domainCheck ? (
                <div className="mt-16">
                  <Callout tone="warn" icon="shield" title={t('域名待验证')}>
                    {t('验证完成前，公网域名暂不生效，可在本机（localhost）继续完成验证。')}
                  </Callout>
                  <div className="form-stack mt-12">
                    <Field label={t('DNS 记录类型')} hint={t('在域名 DNS 服务商处添加一条 TXT 记录。')}>
                      <Input value={domainCheck.record_type || 'TXT'} readOnly disabled />
                    </Field>
                    <Field label={t('记录名')} hint={t('有的服务商要求只填主机记录（不包含主域名后缀）。')}>
                      <div className="row gap-8">
                        <Input value={domainCheck.record_name} readOnly disabled />
                        <CopyButton value={domainCheck.record_name} label={t('复制记录名')} />
                      </div>
                    </Field>
                    <Field label={t('记录值')} hint={t('TXT 记录的内容；验证通过后可以删除。')}>
                      <div className="row gap-8">
                        <Input value={domainCheck.verification_token} readOnly disabled />
                        <CopyButton value={domainCheck.verification_token} label={t('复制记录值')} />
                      </div>
                    </Field>
                  </div>
                  {verifyError ? (
                    <Callout tone="danger" icon="alert" title={t('验证没有通过')}>
                      {verifyError}
                    </Callout>
                  ) : null}
                  <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
                    <Button size="sm" loading={verifyBusy} onClick={runDomainVerify} icon="shield">
                      {t('我已添加，立即验证')}
                    </Button>
                    <span className="tiny faint">
                      {t('DNS 记录生效通常需要几分钟；没通过可以稍后再点一次。')}
                    </span>
                  </div>
                </div>
              ) : null}

              {primaryDomain && domainVerified ? (
                <div className="mt-16">
                  <Callout tone="info" icon="check" title={t('主域名已验证')}>
                    {t('公网域名已经生效；如果刚改过 DNS，浏览器可能需要几分钟缓存。')}
                  </Callout>
                </div>
              ) : null}

              {primaryDomain && !domainPending && !domainVerified && domainCheck && domainCheck.domain ? (
                <div className="mt-16">
                  <Callout tone="info" icon="globe">
                    {t('已保存的域名与当前输入不一致：修改主域名并自动保存后会生成新的 TXT 验证记录。')}
                  </Callout>
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('白名单')}</h3>
                <p>{t('一行一个域名，支持通配符。留空表示不做浏览器端限制。')}</p>
              </div>
              <Toggle
                checked={draft.enabled}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
                label={t('启用域名白名单')}
              />
            </div>
            <div className="panel-body">
              <div className="form-stack">
                {draft.enabled && !primaryText.trim() && !linesOf(aliasText).length ? (
                  <Callout tone="warn" icon="alert" title={t('白名单为空：只允许公网 IP 直连')}>
                    {t('先填写主域名或至少一个别名，白名单才会真正生效；否则生产环境只接受公网 IP。')}
                  </Callout>
                ) : null}
                <Field
                  label={t('别名域名')}
                  htmlFor="domains-aliases"
                  hint={t('例如 www.example.com、blog.example.com 或 *.example.com。主域名不需要重复填写。')}
                >
                  <Textarea
                    id="domains-aliases"
                    value={aliasText}
                    onChange={(event) => setAliasText(event.target.value)}
                    placeholder={'www.example.com\nblog.example.com\n*.example.com'}
                    style={{ minHeight: 120, fontFamily: 'var(--mono)', fontSize: 12.5 }}
                  />
                </Field>
                <div className="form-grid">
                  <Toggle
                    checked={draft.allow_www}
                    onChange={(allow_www) => setDraft({ ...draft, allow_www })}
                    label={t('把 www 视为主域名别名')}
                    description={t('勾选后 www.example.com 会匹配 example.com。')}
                  />
                  <Toggle
                    checked={draft.allow_localhost}
                    onChange={(allow_localhost) => setDraft({ ...draft, allow_localhost })}
                    label={t('允许 localhost')}
                    description={t('本地开发与预览需要；正式站点可按需关闭。')}
                  />
                  <Toggle
                    checked={draft.allow_ip}
                    onChange={(allow_ip) => setDraft({ ...draft, allow_ip })}
                    label={t('允许直接用 IP 访问')}
                    description={t('关闭后只有白名单域名能显示站点。')}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('反向代理与跨域')}</h3>
                <p>{t('这些值只进入生成的 .env；API 需要重启才能读取。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Field
                  label={t('允许的浏览器来源（CORS）')}
                  htmlFor="domains-origins"
                  hint={t('一行一个完整 origin，例如 https://example.com。留空则由上面的域名自动推导。')}
                >
                  <Textarea
                    id="domains-origins"
                    value={originText}
                    onChange={(event) => setOriginText(event.target.value)}
                    placeholder={'https://example.com\nhttps://www.example.com'}
                    style={{ minHeight: 90, fontFamily: 'var(--mono)', fontSize: 12.5 }}
                  />
                </Field>
                <Field
                  label={t('可信代理')}
                  htmlFor="domains-proxies"
                  hint={t('一行一个 IP 或 CIDR。只有来自这些地址的 X-Forwarded-For 才会被相信。')}
                >
                  <Textarea
                    id="domains-proxies"
                    value={proxyText}
                    onChange={(event) => setProxyText(event.target.value)}
                    placeholder={'127.0.0.1\n10.0.0.0/8'}
                    style={{ minHeight: 70, fontFamily: 'var(--mono)', fontSize: 12.5 }}
                  />
                </Field>
                <div className="form-grid">
                  <Field
                    label={t('Cookie 作用域')}
                    htmlFor="domains-cookie"
                    hint={t('多个子域名共享登录态时填写，例如 .example.com。')}
                  >
                    <Input
                      id="domains-cookie"
                      value={draft.cookie_domain}
                      onChange={(event) => setDraft({ ...draft, cookie_domain: event.target.value })}
                      placeholder=".example.com"
                      maxLength={200}
                    />
                  </Field>
                  <div className="form-stack" style={{ gap: 2 }}>
                    <Toggle
                      checked={draft.https_only}
                      onChange={(https_only) => setDraft({ ...draft, https_only })}
                      label={t('强制 HTTPS（生成配置）')}
                      description={t('网关把 80 的请求跳到 443。')}
                    />
                    <Toggle
                      checked={draft.redirect_primary}
                      onChange={(redirect_primary) => setDraft({ ...draft, redirect_primary })}
                      label={t('别名 301 到主域名（生成配置）')}
                      description={t('统一 SEO 与 Cookie 作用域。')}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前生效（只读）')}</h3>
                <p>{t('这些值由 API 在启动时从环境变量读取；上面保存的设置要写进 .env 并重启 API 才会生效。')}</p>
              </div>
              <div className="row gap-8">
                {effective.data?.restart_required ? <Badge tone="warn">{t('需重启')}</Badge> : null}
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh"
                  loading={effective.loading}
                  onClick={effective.reload}
                >
                  {t('刷新')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              {effective.loading && !effective.data ? (
                <Skeleton lines={6} />
              ) : effective.error ? (
                <Callout tone="danger" icon="alert" title={t('无法读取服务端的生效配置')}>
                  {effective.error instanceof Error ? effective.error.message : t('请求失败。')}
                </Callout>
              ) : effective.data ? (
                <div className="form-stack">
                  {effective.data.restart_required ? (
                    <Callout tone="warn" icon="alert" title={t('有设置尚未生效，需要重启 API')}>
                      {t(
                        'API 只在启动时读取 .env；改完这些设置要写进服务器的 .env 再重启，正在运行的进程不会热加载。',
                      )}
                    </Callout>
                  ) : null}
                  <div className="mini-list">
                    <div className="mini-row">
                      <span className="mini-label">{t('允许的浏览器来源（CORS）')}</span>
                      <span className="mini-value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                        {effective.data.cors.allowed_origins.length
                          ? effective.data.cors.allowed_origins.join(' · ')
                          : t('未开放跨域请求')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('允许携带凭证')}</span>
                      <span className="mini-value">
                        {effective.data.cors.allow_credentials ? t('是') : t('否')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('强制 HTTPS')}</span>
                      <span className="mini-value">
                        {effective.data.domains.https_only ? t('是') : t('否')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('公开访问地址')}</span>
                      <span className="mini-value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                        {effective.data.domains.public_base_url || t('未设置：按请求来源推导')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('受信代理')}</span>
                      <span className="mini-value mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                        {effective.data.domains.trusted_proxies.length
                          ? effective.data.domains.trusted_proxies.join(' · ')
                          : t('未配置：忽略转发头')}
                      </span>
                    </div>
                    <div className="mini-row">
                      <span className="mini-label">{t('发信')}</span>
                      <span className="mini-value">
                        {effective.data.mail.configured
                          ? effective.data.mail.from
                            ? t('已配置发信（{from}）', { from: effective.data.mail.from })
                            : t('已配置发信')
                          : t('未配置发信')}
                      </span>
                    </div>
                  </div>
                  <p className="tiny faint">
                    {t('采集时间：{time}', {
                      time: formatDateTime(effective.data.captured_at),
                    })}
                  </p>
                  <p className="tiny faint">
                    {t('API 本身不强制 HTTPS：TLS 由前面的网关终止，这一项反映的是进程自己的配置。')}
                  </p>
                </div>
              ) : (
                <p className="small muted">
                  {t('当前后端没有提供生效配置，无法确认服务端实际启用了哪些设置。')}
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('SSL 证书')}</h3>
                <p>
                  {t('选择 HTTPS 的启用方式；这里只记录部署方式与服务器上的证书路径，不会保存私钥内容。 修改会自动保存，再把下方 Nginx 片段与证书一起部署。')}
                </p>
              </div>
              <Badge tone={draft.tls.mode === 'off' ? 'muted' : 'ok'}>
                {draft.tls.mode === 'off'
                  ? t('未启用')
                  : draft.tls.mode === 'letsencrypt'
                    ? "Let's Encrypt"
                    : t('手动证书')}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="option-grid three">
                {(
                  [
                    { key: 'off' as const, name: t('不启用'), note: t('只用 HTTP；由前置代理终止 TLS。') },
                    {
                      key: 'letsencrypt' as const,
                      name: "Let's Encrypt",
                      note: t('生成 certbot 申请命令与证书路径。'),
                    },
                    { key: 'manual' as const, name: t('手动证书'), note: t('已有证书链与私钥文件。') },
                  ]
                ).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`option${draft.tls.mode === option.key ? ' is-selected' : ''}`}
                    onClick={() => setDraft({ ...draft, tls: { ...draft.tls, mode: option.key } })}
                  >
                    <span className="option-icon">
                      <Icon name="lock" size={16} />
                    </span>
                    <span className="option-body">
                      <strong>{option.name}</strong>
                      <p>{option.note}</p>
                    </span>
                    <span className="option-radio" />
                  </button>
                ))}
              </div>

              {draft.tls.mode === 'letsencrypt' ? (
                <div className="form-stack mt-16">
                  <Field
                    label={t('通知邮箱')}
                    htmlFor="domains-tls-email"
                    hint={t('到期提醒与证书注册使用；不会写进浏览器存储之外的公开位置。')}
                  >
                    <Input
                      id="domains-tls-email"
                      value={draft.tls.email}
                      onChange={(event) =>
                        setDraft({ ...draft, tls: { ...draft.tls, email: event.target.value } })
                      }
                      placeholder="ops@example.com"
                      maxLength={200}
                    />
                  </Field>
                  <Callout tone="info" icon="lock">
                    {t('需要主域名已解析到本机，并允许 80/443 入站。下方「部署片段」里有 certbot 申请命令； 证书续期用')}{' '}
                    <code className="mono">certbot renew</code>
                    {t('。')}
                  </Callout>
                </div>
              ) : null}

              {draft.tls.mode === 'manual' ? (
                <div className="form-grid mt-16">
                  <Field
                    label={t('证书链路径')}
                    htmlFor="domains-tls-cert"
                    hint={t('服务器上的 fullchain 文件，例如 /etc/ssl/certs/press.example.com.pem。')}
                  >
                    <Input
                      id="domains-tls-cert"
                      value={draft.tls.cert_path}
                      onChange={(event) =>
                        setDraft({ ...draft, tls: { ...draft.tls, cert_path: event.target.value } })
                      }
                      placeholder="/etc/ssl/certs/fullchain.pem"
                      maxLength={300}
                    />
                  </Field>
                  <Field
                    label={t('私钥路径')}
                    htmlFor="domains-tls-key"
                    hint={t('只填写路径；不要把私钥粘贴到浏览器或提交到 Git。')}
                  >
                    <Input
                      id="domains-tls-key"
                      value={draft.tls.key_path}
                      onChange={(event) =>
                        setDraft({ ...draft, tls: { ...draft.tls, key_path: event.target.value } })
                      }
                      placeholder="/etc/ssl/private/privkey.pem"
                      maxLength={300}
                    />
                  </Field>
                </div>
              ) : null}

              <div className="mt-16">
                <Toggle
                  checked={draft.tls.hsts}
                  onChange={(hsts) => setDraft({ ...draft, tls: { ...draft.tls, hsts } })}
                  label={t('启用 HSTS')}
                  description={t('启用后浏览器会强制使用 HTTPS；确认所有子域名都已支持 HTTPS 再打开。')}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('部署片段')}</h3>
                <p>{t('按已保存的设置生成，复制后请按实际证书路径与静态目录调整。')}</p>
              </div>
              <div className="row gap-8">
                <CopyButton
                  value={buildGatewaySnippet(access, saved, site?.domain)}
                  label={t('复制 Nginx')}
                />
                <CopyButton value={buildDomainEnvSnippet(saved, site?.domain)} label={t('复制 .env')} />
                <CopyButton
                  value={buildTlsSetupSnippet(saved, site?.domain)}
                  label={t('复制证书步骤')}
                />
              </div>
            </div>
            <div className="panel-body">
              <pre className="auth-env-code">{buildGatewaySnippet(access, saved, site?.domain)}</pre>
              <details className="mt-12">
                <summary className="link-btn">{t('展开 API 环境变量')}</summary>
                <pre className="auth-env-code">{buildDomainEnvSnippet(saved, site?.domain)}</pre>
              </details>
              <details className="mt-12">
                <summary className="link-btn">{t('展开证书申请 / 部署步骤')}</summary>
                <pre className="auth-env-code">{buildTlsSetupSnippet(saved, site?.domain)}</pre>
              </details>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('绑定概览')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('当前域名')}</span>
                  <span className="mini-value mono" style={{ fontSize: 11 }}>
                    {host || '—'}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('白名单')}</span>
                  <span className="mini-value">
                    {saved.enabled ? t('{count} 个', { count: allowed.length }) : t('关闭')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">local / IP</span>
                  <span className="mini-value">
                    {saved.allow_localhost ? 'localhost' : t('不豁免')} ·{' '}
                    {saved.allow_ip ? t('允许 IP') : t('禁止 IP')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">TLS</span>
                  <span className="mini-value">
                    {saved.tls.mode === 'off'
                      ? t('未启用')
                      : saved.tls.mode === 'letsencrypt'
                        ? "Let's Encrypt"
                        : t('手动证书')}
                    {saved.tls.hsts ? ' · HSTS' : ''}
                  </span>
                </div>
              </div>
              <div className="domain-bind-list mt-16">
                {allowed.length ? (
                  allowed.map((item) => (
                    <div key={item} className="domain-bind-item">
                      <Icon name="globe" size={13} />
                      <code className="mono">{item}</code>
                    </div>
                  ))
                ) : (
                  <p className="tiny faint">{t('还没有别名；主域名为空时不会限制访问。')}</p>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('DNS 检查清单')}</h3>
                <p>{t('绑定域名还需要这些步骤。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <ul className="domain-checklist">
                <li>{t('给主域名添加 A / AAAA 记录，指向服务器地址。')}</li>
                <li>{t('别名用 CNAME 指向主域名，或单独添加 A 记录。')}</li>
                <li>{t('为每个域名签发 TLS 证书，或使用通配证书。')}</li>
                <li>
                  {t('把上方 Nginx 的')} <code className="mono">server_name</code> {t('填全。')}
                </li>
                <li>
                  {t('把 API 的')} <code className="mono">PUBLIC_BASE_URL</code> {t('设为主域名。')}
                </li>
              </ul>
              <Button
                variant="secondary"
                size="sm"
                className="mt-12"
                icon="external"
                onClick={() =>
                  window.open(`https://dns.google/query?name=${encodeURIComponent(primary)}`, '_blank', 'noopener')
                }
                disabled={!primary}
              >
                {t('打开 DNS 查询')}
              </Button>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认域名设置')}</h3>
            <p>{t('关闭白名单并清空别名、CORS 与代理地址；主域名本身不会被修改。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>
    </RoleGate>
  );
}
