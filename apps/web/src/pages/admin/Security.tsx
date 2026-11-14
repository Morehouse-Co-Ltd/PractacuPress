import { useSearchParams } from 'react-router-dom';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/usePermissions';
import { Callout } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { ReviewPage } from './Review';
import { ReportsPage } from './Reports';
import { CommentsPage } from './Comments';

type SecurityTab = 'review' | 'reports' | 'comments';

interface SecurityTabEntry {
  key: SecurityTab;
  label: string;
  icon: IconName;
  allowed: boolean;
}

/**
 * 信息安全中心。
 *
 * 审核、举报与评论审核原本是侧栏三个入口，都在处理「内容是否该被看见」这件事；
 * 合并成一页后用三个小 tab 切换，侧栏少三行，队列之间的切换也不用重新找入口。
 * 个人博客没有「别人投稿、站长审核」的流程，审核 tab 直接不出现。
 */
export function SecurityPage() {
  const t = useT();
  useTitle(t('信息安全'));
  const [params, setParams] = useSearchParams();
  const { can, personal } = usePermissions();

  const tabs: SecurityTabEntry[] = [
    {
      key: 'review',
      label: t('审核'),
      icon: 'shield',
      allowed: can('moderate_content') && !personal,
    },
    { key: 'reports', label: t('举报'), icon: 'alert', allowed: can('moderate_content') },
    { key: 'comments', label: t('评论与审核'), icon: 'message', allowed: can('moderate_comment') },
  ];
  const allowed = tabs.filter((tab) => tab.allowed);

  if (!allowed.length) {
    return (
      <Callout tone="warn" icon="lock" title={t('没有可用的信息安全权限')}>
        {t('这个账户不能审核内容、处理举报或管理评论。')}
      </Callout>
    );
  }

  const requested = params.get('tab');
  const active = allowed.find((tab) => tab.key === requested)?.key ?? allowed[0].key;
  const select = (next: SecurityTab) => {
    const copy = new URLSearchParams(params);
    if (next === allowed[0].key) copy.delete('tab');
    else copy.set('tab', next);
    setParams(copy, { replace: true });
  };

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('信息安全')}</h1>
          <p>
            {t('审核待发布内容、处理读者举报、管理评论。三种队列在这里汇合，处理动作都会写入网站日志。')}
          </p>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label={t('信息安全')}>
        {allowed.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`security-tab-${tab.key}`}
            aria-controls={`security-panel-${tab.key}`}
            aria-selected={active === tab.key}
            className={`admin-tab${active === tab.key ? ' is-active' : ''}`}
            onClick={() => select(tab.key)}
          >
            <Icon name={tab.icon} size={14} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div
        className="mt-20"
        id={`security-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`security-tab-${active}`}
      >
        {active === 'review' ? (
          <ReviewPage embedded />
        ) : active === 'reports' ? (
          <ReportsPage embedded />
        ) : (
          <CommentsPage embedded />
        )}
      </div>
    </>
  );
}
