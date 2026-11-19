import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccessSettings, RateRule } from '../../types';
import { useAuth } from '../../lib/session';
import { useSaveSiteConfig } from '../../lib/siteConfigSave';
import { useBackend } from '../../lib/backend';
import {
  accessController,
  DEFAULT_ACCESS,
  readAccess,
  useAccessSnapshot,
} from '../../lib/access';
import { readDomains } from '../../lib/domains';
import { useSiteTabPresence } from '../../lib/tabPresence';
import {
  buildAccessEnvSnippet,
  buildGatewaySnippet,
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
  Input,
  Toggle,
} from '../../components/ui';
import { AutoSaveStatus, type AutoSaveState } from '../../components/AutoSaveStatus';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';

/** 自动保存的防抖间隔：停下编辑这么久才写服务端，避免每敲一下都发一次 PUT。 */
const AUTOSAVE_DELAY_MS = 700;

function RuleEditor({
  idPrefix,
  rule,
  onChange,
}: {
  idPrefix: string;
  rule: RateRule;
  onChange: (rule: RateRule) => void;
}) {
  const t = useT();
  const patch = (next: Partial<RateRule>) => onChange({ ...rule, ...next });
  return (
    <div className="form-stack">
      <Toggle
        checked={rule.enabled}
        onChange={(enabled) => patch({ enabled })}
        label={t('启用这条规则')}
        description={t('只影响浏览器端记录；网关配置会另外按这里的数值生成。')}
      />
      <div className="form-grid">
        <NumberField
          id={`${idPrefix}-limit`}
          label={t('允许次数')}
          value={rule.limit}
          min={1}
          max={10000}
          unit={t('次')}
          onChange={(limit) => patch({ limit })}
        />
        <NumberField
          id={`${idPrefix}-window`}
          label={t('统计窗口')}
          hint={t('在这个时间范围内统计。')}
          value={rule.window_seconds}
          min={1}
          max={3600}
          unit={t('秒')}
          onChange={(window_seconds) => patch({ window_seconds })}
        />
        <NumberField
          id={`${idPrefix}-block`}
          label={t('触发后暂停')}
          hint={t('暂停期间访客会看到拦截页与倒计时。')}
          value={rule.block_seconds}
          min={1}
          max={86400}
          unit={t('秒')}
          onChange={(block_seconds) => patch({ block_seconds })}
        />
      </div>
    </div>
  );
}

export function AccessPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  useTitle(embedded ? t('访问与域名') : t('访问限制'));
  const { config, site, me } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saveSiteConfig = useSaveSiteConfig();
  const saved = useMemo(() => readAccess(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<AccessSettings>(() => saved);
  const snapshot = useAccessSnapshot(1000);
  const tabs = useSiteTabPresence(saved.enabled && saved.tabs.enabled, saved.tabs.limit);
  const domains = useMemo(() => readDomains(config), [config]);
  /** 自动保存状态：设置改成自动保存后，这是站长确认改动真的落地的唯一入口。 */
  const [saveState, setSaveState] = useState<AutoSaveState>('idle');
  const [saveError, setSaveError] = useState('');
  /**
   * 最近一次写入服务端的载荷签名。
   *
   * 初值就是首屏那份配置：挂载时草稿与配置一致、签名相同，自动保存不会在打开页面
   * 时白写一次。之后成功的保存、配置回填与「恢复默认」都会更新它。
   */
  const lastSavedRef = useRef(savedKey);
  /**
   * 草稿与最近一次写入/回填的内容是否不同。
   *
   * 用「上次保存的基线」而不是「当前配置」判断：站点会在挂载后再水合一次配置，
   * 若拿未变的草稿去比新配置，会被误判成「有未保存修改」而拒绝回填。
   */
  const draftSignature = JSON.stringify(readAccess({ access: draft }));
  const dirty = draftSignature !== lastSavedRef.current;
  /** 定时器与排队任务里读最新草稿，避免拿到旧闭包。 */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** 有没有更新的本地编辑；配置回填时据此决定要不要覆盖输入。 */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** 串行队列：同一时间只允许一笔保存在途，避免后发请求被前一笔覆盖。 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  // 保存后跟着配置收敛一次，避免草稿与真正生效的规则分叉。
  // 只在没有更新的本地编辑时回填：否则保存响应会把用户刚敲进去的内容冲掉。
  useEffect(() => {
    const next = readAccess(config);
    const nextKey = JSON.stringify(next);
    if (dirtyRef.current) return;
    lastSavedRef.current = nextKey;
    setDraft((prev) => (JSON.stringify(prev) === nextKey ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  /** 串行写：自动保存与「恢复默认」都排队，保证最后一次操作真正落库。 */
  const queueSave = (task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task).catch(() => {});
  };

  /** 自动保存：整份草稿写回站点配置，成功后再提示并记录动态。 */
  const autosave = () => {
    queueSave(async () => {
      const next = readAccess({ access: draftRef.current });
      const signature = JSON.stringify(next);
      // 排队期间草稿可能已经保存过（或被回填成同一份）：不重复写。
      if (signature === lastSavedRef.current) {
        setSaveState((prev) => (prev === 'pending' ? 'idle' : prev));
        return;
      }
      setSaveState('saving');
      setSaveError('');
      let ok = false;
      try {
        ok = await saveSiteConfig({ access: next });
      } catch {
        // saveSiteConfig 自己会提示服务端拒绝的原因，这里只兜住意外。
        ok = false;
      }
      // 失败时本地配置已经被乐观更新：基线跟着走到这份载荷，避免自动重试风暴。
      lastSavedRef.current = signature;
      if (!ok) {
        setSaveError(t('自动保存失败'));
        setSaveState('error');
        return;
      }
      // 保存期间可能又改过：只有没有更新的编辑时才把草稿收敛成归一化后的写法。
      if (JSON.stringify(draftRef.current) === signature) {
        draftRef.current = next;
        setDraft(next);
      }
      setSaveState('saved');
      toast.push('ok', t('已自动保存'));
      if (me) {
        noteActivity(
          backend,
          me.user.display_name,
          '修改访问限制',
          site?.name ?? '站点',
          next.enabled ? '已启用' : '已关闭',
        );
      }
    });
  };

  // 草稿停下 700ms 后自动保存；签名与上次写入一致说明只是回填/重复渲染，不发请求。
  useEffect(() => {
    const signature = JSON.stringify(readAccess({ access: draft }));
    if (signature === lastSavedRef.current) {
      // 用回已保存的内容时清掉旧错误：pending / error 都收回 idle，「已保存」保留。
      setSaveState((prev) => (prev === 'pending' || prev === 'error' ? 'idle' : prev));
      setSaveError((prev) => (prev ? '' : prev));
      return;
    }
    setSaveState('pending');
    const timer = window.setTimeout(autosave, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /** 队列/定时器里的最新保存函数；卸载时用它补写，避免 700ms 内切走丢掉修改。 */
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  useEffect(() => {
    return () => {
      if (dirtyRef.current) autosaveRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = async () => {
    queueSave(async () => {
      // 恢复默认是一次显式写入：先把它设成基线，排队中的旧草稿不会再覆盖回去。
      lastSavedRef.current = JSON.stringify(DEFAULT_ACCESS);
      const ok = await saveSiteConfig({ access: DEFAULT_ACCESS });
      draftRef.current = DEFAULT_ACCESS;
      setDraft(DEFAULT_ACCESS);
      accessController.clear();
      if (!ok) {
        setSaveError(t('自动保存失败'));
        setSaveState('error');
        return;
      }
      setSaveError('');
      setSaveState('saved');
      toast.push('ok', t('已恢复默认限制'), t('浏览器端保护已关闭；已保存的网关数值也回到默认。'));
    });
  };

  const clearBlock = () => {
    accessController.clear();
    toast.push('ok', t('已解除当前标签页的限制'), t('这个标签页里的管理后台与前台页面都可以继续访问。'));
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className={embedded ? 'admin-page-head embedded-section-head' : 'admin-page-head'}>
        <div>
          {embedded ? <h2>{t('访问限制')}</h2> : <h1>{t('访问限制')}</h1>}
          <p>
            {t('限制页面切换、页面请求与同浏览器并发页面，避免脚本或异常客户端拖垮站点。')}{' '}
            {t('真正的 IP 级 DDoS / CC 防护由网关执行，本页同时生成可直接部署的规则。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <AutoSaveStatus state={saveState} error={saveError} />
          <Button variant="ghost" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            {t('查看前台')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="shield" title={t('浏览器端只能挡住使用本站脚本的访问者')}>
        {t('它适合拦住失控的前端脚本、误触与普通爬虫，但无法阻止直接请求 API 或静态资源的机器人。')}{' '}
        {t('要真正按 IP 限制请求和并发，请把下方片段部署到 Nginx 或 Cloudflare 等网关。')}{' '}
        {t('管理后台、安装向导与页面编排预览始终豁免，站长不会被锁在门外。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('浏览器端保护')}</h3>
                <p>{t('总开关。关闭后下面三条规则都不会在本站脚本里执行。')}</p>
              </div>
              <Badge tone={saved.enabled ? 'ok' : 'muted'} dot={saved.enabled}>
                {saved.enabled ? t('已启用') : t('未启用')}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                  label={t('启用浏览器端访问限制')}
                  description={t('建议先启用页面切换与并发页面限制；请求限制可根据站点脚本数量调整。')}
                />
                <Field
                  label={t('拦截提示')}
                  htmlFor="access-message"
                  aside={`${draft.message.length}/200`}
                  hint={t('访客被拦住时看到的说明；留空使用默认文案。')}
                >
                  <Input
                    id="access-message"
                    value={draft.message}
                    maxLength={200}
                    onChange={(event) => setDraft({ ...draft, message: event.target.value })}
                  />
                </Field>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('页面切换限制')}</h3>
                <p>{t('限制一段时间内打开或切换页面的次数，对应 CC 攻击里最便宜的请求。')}</p>
              </div>
              <Badge tone={draft.page_switch.enabled ? 'accent' : 'muted'}>
                {t('{limit} 次 / {window} 秒', {
                  limit: draft.page_switch.limit,
                  window: draft.page_switch.window_seconds,
                })}
              </Badge>
            </div>
            <div className="panel-body">
              <RuleEditor
                idPrefix="access-page"
                rule={draft.page_switch}
                onChange={(page_switch) => setDraft({ ...draft, page_switch })}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('请求限制')}</h3>
                <p>{t('限制页面脚本在窗口内发起的后端请求；命中缓存也按一次调用计。')}</p>
              </div>
              <Badge tone={draft.requests.enabled ? 'accent' : 'muted'}>
                {t('{limit} 次 / {window} 秒', {
                  limit: draft.requests.limit,
                  window: draft.requests.window_seconds,
                })}
              </Badge>
            </div>
            <div className="panel-body">
              <RuleEditor
                idPrefix="access-req"
                rule={draft.requests}
                onChange={(requests) => setDraft({ ...draft, requests })}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('并发页面')}</h3>
                <p>{t('同一浏览器允许同时打开的站点标签页；网关里对应每 IP 并发连接。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.tabs.enabled}
                  onChange={(enabled) =>
                    setDraft({ ...draft, tabs: { ...draft.tabs, enabled } })
                  }
                  label={t('启用并发页面限制')}
                  description={t('只统计前台标签页，后台和编排预览不占名额。')}
                />
                <NumberField
                  id="access-tabs-limit"
                  label={t('同时打开的页面')}
                  hint={t('超过后最新打开的标签会被拦住，关闭其他标签即恢复。')}
                  value={draft.tabs.limit}
                  min={1}
                  max={64}
                  unit={t('个')}
                  onChange={(limit) => setDraft({ ...draft, tabs: { ...draft.tabs, limit } })}
                />
                <Callout tone="warn" icon="info" title={t('浏览器只能看到同一个浏览器')}>
                  {t('浏览器拿不到“同一 IP 的其他设备”。下方 Nginx 的 limit_conn 才是按 IP 的并发连接限制。')}
                </Callout>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('网关配置')}</h3>
                <p>{t('按已保存的规则生成；复制到 Nginx 后才能真正按 IP 限制请求和并发。')}</p>
              </div>
              <Badge tone="muted">{t('不会自动修改服务器')}</Badge>
            </div>
            <div className="panel-body">
              <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                <CopyButton value={buildGatewaySnippet(saved, domains, site?.domain)} label={t('复制 Nginx')} />
                <CopyButton
                  value={buildAccessEnvSnippet(saved, domains)}
                  label={t('复制 API .env')}
                />
              </div>
              <pre className="auth-env-code">
                {buildGatewaySnippet(saved, domains, site?.domain)}
              </pre>
              <details className="mt-12">
                <summary className="link-btn">{t('展开 API 环境变量')}</summary>
                <pre className="auth-env-code">
                  {buildAccessEnvSnippet(saved, domains)}
                </pre>
              </details>
              <p className="tiny faint mt-12">
                {t('Nginx 片段里的 Host 已改写为主域名；否则 API 会把别名域名当成未知站点。')}{' '}
                {t('片段假设 Nginx 直接读取构建好的静态文件，只把')}{' '}
                <code className="mono">/api/</code>{' '}
                {t('代理到 Go 服务。')}{' '}
                {t('请求规则只作用在')}{' '}
                <code className="mono">/api/</code>
                {t('，页面规则作用在 HTML 文档；')}{' '}
                {t('并发页面按每页约 4 条连接换算，避免正常的单页访问被 limit_conn 误伤。')}{' '}
                {t('浏览器端总开关不影响这里的网关规则；不需要某条规则时，把上方对应开关关掉再复制。')}{' '}
                {t('使用 Cloudflare 时，在其速率限制规则里填同样的阈值即可。')}
              </p>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前状态')}</h3>
                <p>{t('浏览器端计数每分钟自动收敛。')}</p>
              </div>
              <Button variant="ghost" size="sm" icon="refresh" onClick={clearBlock}>
                {t('解除')}
              </Button>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('页面切换')}</span>
                  <span className="mini-value">
                    {snapshot.pageSwitches} / {saved.page_switch.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('请求')}</span>
                  <span className="mini-value">
                    {snapshot.requests} / {saved.requests.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('站点标签页')}</span>
                  <span className="mini-value">
                    {tabs.count} / {saved.tabs.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('状态')}</span>
                  <span className="mini-value">
                    {snapshot.reason || (saved.tabs.enabled && tabs.over) ? t('已触发限制') : t('正常')}
                  </span>
                </div>
              </div>
              {snapshot.reason ? (
                <Callout tone="warn" icon="alert" title={t('当前标签页被限制')}>
                  {t('剩余约 {seconds} 秒。点击「解除」可以立即清空当前标签页的状态。', {
                    seconds: Math.ceil(snapshot.retryAfterMs / 1000),
                  })}
                </Callout>
              ) : null}
              <p className="tiny faint mt-12">
                {t('这些计数只属于当前标签页。其它标签页各自计数；并发页面由标签心跳汇总。')}
              </p>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认限制')}</h3>
            <p>{t('关闭浏览器端保护，并把三条规则恢复为初始值。不会删除文章、账户或评论。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>
    </RoleGate>
  );
}
