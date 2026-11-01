import { useEffect, useMemo, useState } from 'react';
import type { AccessSettings, RateRule } from '../../types';
import { useAuth } from '../../lib/session';
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
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';

function RuleEditor({
  idPrefix,
  rule,
  onChange,
}: {
  idPrefix: string;
  rule: RateRule;
  onChange: (rule: RateRule) => void;
}) {
  const patch = (next: Partial<RateRule>) => onChange({ ...rule, ...next });
  return (
    <div className="form-stack">
      <Toggle
        checked={rule.enabled}
        onChange={(enabled) => patch({ enabled })}
        label="启用这条规则"
        description="只影响浏览器端记录；网关配置会另外按这里的数值生成。"
      />
      <div className="form-grid">
        <NumberField
          id={`${idPrefix}-limit`}
          label="允许次数"
          value={rule.limit}
          min={1}
          max={10000}
          unit="次"
          onChange={(limit) => patch({ limit })}
        />
        <NumberField
          id={`${idPrefix}-window`}
          label="统计窗口"
          hint="在这个时间范围内统计。"
          value={rule.window_seconds}
          min={1}
          max={3600}
          unit="秒"
          onChange={(window_seconds) => patch({ window_seconds })}
        />
        <NumberField
          id={`${idPrefix}-block`}
          label="触发后暂停"
          hint="暂停期间访客会看到拦截页与倒计时。"
          value={rule.block_seconds}
          min={1}
          max={86400}
          unit="秒"
          onChange={(block_seconds) => patch({ block_seconds })}
        />
      </div>
    </div>
  );
}

export function AccessPage({ embedded = false }: { embedded?: boolean }) {
  useTitle(embedded ? '访问与域名' : '访问限制');
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saved = useMemo(() => readAccess(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<AccessSettings>(() => saved);
  const snapshot = useAccessSnapshot(1000);
  const tabs = useSiteTabPresence(saved.enabled && saved.tabs.enabled, saved.tabs.limit);
  const domains = useMemo(() => readDomains(config), [config]);
  const dirty = JSON.stringify(draft) !== savedKey;

  // 保存后跟着配置收敛一次，避免草稿与真正生效的规则分叉。
  useEffect(() => {
    setDraft(readAccess(config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const save = () => {
    const next = readAccess({ access: draft });
    updateConfig({ access: next });
    setDraft(next);
    toast.push('ok', '访问限制已保存', next.enabled ? '浏览器端规则立即生效。' : '浏览器端保护当前关闭。');
    if (me) {
      noteActivity(backend, me.user.display_name, '修改访问限制', site?.name ?? '站点', next.enabled ? '已启用' : '已关闭');
    }
  };

  const reset = () => {
    updateConfig({ access: DEFAULT_ACCESS });
    setDraft(DEFAULT_ACCESS);
    accessController.clear();
    toast.push('ok', '已恢复默认限制', '浏览器端保护已关闭；已保存的网关数值也回到默认。');
  };

  const clearBlock = () => {
    accessController.clear();
    toast.push('ok', '已解除当前标签页的限制', '这个标签页里的管理后台与前台页面都可以继续访问。');
  };

  return (
    <RoleGate capability="manage_site" need="站点管理员">
      <div className={embedded ? 'admin-page-head embedded-section-head' : 'admin-page-head'}>
        <div>
          {embedded ? <h2>访问限制</h2> : <h1>访问限制</h1>}
          <p>
            限制页面切换、页面请求与同浏览器并发页面，避免脚本或异常客户端拖垮站点。
            真正的 IP 级 DDoS / CC 防护由网关执行，本页同时生成可直接部署的规则。
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            查看前台
          </Button>
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            保存修改
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="shield" title="浏览器端只能挡住使用本站脚本的访问者">
        它适合拦住失控的前端脚本、误触与普通爬虫，但无法阻止直接请求 API 或静态资源的机器人。
        要真正按 IP 限制请求和并发，请把下方片段部署到 Nginx 或 Cloudflare 等网关。
        管理后台、安装向导与页面编排预览始终豁免，站长不会被锁在门外。
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>浏览器端保护</h3>
                <p>总开关。关闭后下面三条规则都不会在本站脚本里执行。</p>
              </div>
              <Badge tone={saved.enabled ? 'ok' : 'muted'} dot={saved.enabled}>
                {saved.enabled ? '已启用' : '未启用'}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                  label="启用浏览器端访问限制"
                  description="建议先启用页面切换与并发页面限制；请求限制可根据站点脚本数量调整。"
                />
                <Field
                  label="拦截提示"
                  htmlFor="access-message"
                  aside={`${draft.message.length}/200`}
                  hint="访客被拦住时看到的说明；留空使用默认文案。"
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
                <h3>页面切换限制</h3>
                <p>限制一段时间内打开或切换页面的次数，对应 CC 攻击里最便宜的请求。</p>
              </div>
              <Badge tone={draft.page_switch.enabled ? 'accent' : 'muted'}>
                {draft.page_switch.limit} 次 / {draft.page_switch.window_seconds} 秒
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
                <h3>请求限制</h3>
                <p>限制页面脚本在窗口内发起的后端请求；命中缓存也按一次调用计。</p>
              </div>
              <Badge tone={draft.requests.enabled ? 'accent' : 'muted'}>
                {draft.requests.limit} 次 / {draft.requests.window_seconds} 秒
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
                <h3>并发页面</h3>
                <p>同一浏览器允许同时打开的站点标签页；网关里对应每 IP 并发连接。</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.tabs.enabled}
                  onChange={(enabled) =>
                    setDraft({ ...draft, tabs: { ...draft.tabs, enabled } })
                  }
                  label="启用并发页面限制"
                  description="只统计前台标签页，后台和编排预览不占名额。"
                />
                <NumberField
                  id="access-tabs-limit"
                  label="同时打开的页面"
                  hint="超过后最新打开的标签会被拦住，关闭其他标签即恢复。"
                  value={draft.tabs.limit}
                  min={1}
                  max={64}
                  unit="个"
                  onChange={(limit) => setDraft({ ...draft, tabs: { ...draft.tabs, limit } })}
                />
                <Callout tone="warn" icon="info" title="浏览器只能看到同一个浏览器">
                  浏览器拿不到“同一 IP 的其他设备”。下方 Nginx 的 limit_conn 才是按 IP 的并发连接限制。
                </Callout>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>网关配置</h3>
                <p>按已保存的规则生成；复制到 Nginx 后才能真正按 IP 限制请求和并发。</p>
              </div>
              <Badge tone="muted">不会自动修改服务器</Badge>
            </div>
            <div className="panel-body">
              <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                <CopyButton value={buildGatewaySnippet(saved, domains, site?.domain)} label="复制 Nginx" />
                <CopyButton
                  value={buildAccessEnvSnippet(saved, domains)}
                  label="复制 API .env"
                />
              </div>
              <pre className="auth-env-code">
                {buildGatewaySnippet(saved, domains, site?.domain)}
              </pre>
              <details className="mt-12">
                <summary className="link-btn">展开 API 环境变量</summary>
                <pre className="auth-env-code">
                  {buildAccessEnvSnippet(saved, domains)}
                </pre>
              </details>
              <p className="tiny faint mt-12">
                Nginx 片段里的 Host 已改写为主域名；否则 API 会把别名域名当成未知站点。
                片段假设 Nginx 直接读取构建好的静态文件，只把 <code className="mono">/api/</code> 代理到 Go 服务。
                请求规则只作用在 <code className="mono">/api/</code>，页面规则作用在 HTML 文档；
                并发页面按每页约 4 条连接换算，避免正常的单页访问被 limit_conn 误伤。
                浏览器端总开关不影响这里的网关规则；不需要某条规则时，把上方对应开关关掉再复制。
                使用 Cloudflare 时，在其速率限制规则里填同样的阈值即可。
              </p>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>当前状态</h3>
                <p>浏览器端计数每分钟自动收敛。</p>
              </div>
              <Button variant="ghost" size="sm" icon="refresh" onClick={clearBlock}>
                解除
              </Button>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">页面切换</span>
                  <span className="mini-value">
                    {snapshot.pageSwitches} / {saved.page_switch.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">请求</span>
                  <span className="mini-value">
                    {snapshot.requests} / {saved.requests.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">站点标签页</span>
                  <span className="mini-value">
                    {tabs.count} / {saved.tabs.limit}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">状态</span>
                  <span className="mini-value">
                    {snapshot.reason || (saved.tabs.enabled && tabs.over) ? '已触发限制' : '正常'}
                  </span>
                </div>
              </div>
              {snapshot.reason ? (
                <Callout tone="warn" icon="alert" title="当前标签页被限制">
                  剩余约 {Math.ceil(snapshot.retryAfterMs / 1000)} 秒。点击「解除」可以立即清空当前标签页的状态。
                </Callout>
              ) : null}
              <p className="tiny faint mt-12">
                这些计数只属于当前标签页。其它标签页各自计数；并发页面由标签心跳汇总。
              </p>
            </div>
          </section>

          <div className="danger-zone">
            <h3>恢复默认限制</h3>
            <p>关闭浏览器端保护，并把三条规则恢复为初始值。不会删除文章、账户或评论。</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              恢复默认
            </Button>
          </div>
        </aside>
      </div>

      <div className="row gap-8 mt-20">
        <Button disabled={!dirty} onClick={save} icon="check">
          保存修改
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            onClick={() => setDraft(readAccess(config))}
          >
            放弃未保存的修改
          </Button>
        ) : (
          <span className="tiny faint">没有未保存的修改</span>
        )}
        <span className="tiny faint">
          <Icon name="shield" size={12} /> 管理后台请求不受这些限制影响
        </span>
      </div>
    </RoleGate>
  );
}
