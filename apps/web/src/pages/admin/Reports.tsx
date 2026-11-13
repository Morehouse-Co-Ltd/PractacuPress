import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Report, ReportAction } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { formatDateTime, shortId } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/usePermissions';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Modal,
  PageLoading,
  Textarea,
} from '../../components/ui';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

const REASON_LABEL: Record<Report['reason'], string> = {
  spam: '垃圾广告',
  abuse: '辱骂与骚扰',
  illegal: '违法或侵权',
  other: '其他',
};

const ACTION_LABEL: Record<ReportAction, string> = {
  ignore: '忽略举报',
  takedown: '下架内容',
  ban: '封禁账户',
};

export function ReportsPage() {
  const t = useT();
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const { can } = usePermissions();
  const toast = useToast();
  const [items, setItems] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<{ report: Report; action: ReportAction } | null>(null);
  const [note, setNote] = useState('');
  useTitle(t('举报队列'));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await backend.reports());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('举报队列加载失败。'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [backend, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (report: Report) => {
    setBusy(report.id);
    try {
      await backend.assignReport(report.id);
      toast.push('ok', t('已认领举报'));
      await load();
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy('');
    }
  };

  const resolve = async () => {
    if (!pending) return;
    setBusy(pending.report.id);
    try {
      await backend.resolveReport(pending.report.id, pending.action, note);
      if (me) {
        noteActivity(
          backend,
          me.user.display_name,
          ACTION_LABEL[pending.action],
          pending.report.target_id,
        );
      }
      toast.push('ok', t('举报已处理'));
      setPending(null);
      setNote('');
      await load();
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy('');
    }
  };

  const targetLink = (report: Report) => {
    if (report.target_type === 'article') return `/a/${report.target_id}`;
    if (report.target_type === 'post') return `/p/${report.target_id}`;
    if (report.target_type === 'user') return `/u/${report.target_id}`;
    return '';
  };

  const statusLabel: Record<Report['status'], string> = {
    open: t('待处理'),
    assigned: t('处理中'),
    resolved: t('已处理'),
    dismissed: t('已忽略'),
  };

  return (
    <RoleGate capability="moderate_content" need={t('审核员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('举报队列')}</h1>
          <p>{t('读者举报的内容与账户会进入这里。处理动作会写入审计日志并通知相关作者。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load()}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-16">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {loading ? (
        <PageLoading label={t('正在载入举报')} />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="shield"
            title={t('暂无待处理举报')}
            body={t('内容页上的“举报”按钮提交后会出现在这里。')}
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('目标')}</th>
                  <th>{t('原因')}</th>
                  <th>{t('说明')}</th>
                  <th>{t('举报人')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('时间')}</th>
                  <th style={{ width: 260 }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((report) => {
                  const link = targetLink(report);
                  return (
                    <tr key={report.id}>
                      <td>
                        <div className="tiny muted">{report.target_type}</div>
                        {link ? (
                          <Link to={link} className="text-link">
                            {shortId(report.target_id)}
                          </Link>
                        ) : (
                          <span className="mono tiny">{shortId(report.target_id)}</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={report.reason === 'illegal' ? 'danger' : 'warn'}>
                          {t(REASON_LABEL[report.reason])}
                        </Badge>
                      </td>
                      <td className="tiny" style={{ maxWidth: 260 }}>
                        {report.note ? report.note : <span className="faint">—</span>}
                      </td>
                      <td className="tiny muted">{shortId(report.reporter_id)}</td>
                      <td>
                        <Badge tone={report.status === 'assigned' ? 'ok' : 'warn'} dot>
                          {statusLabel[report.status]}
                        </Badge>
                        {report.assignee_id ? (
                          <div className="tiny faint">{shortId(report.assignee_id)}</div>
                        ) : null}
                      </td>
                      <td className="tiny muted">{formatDateTime(report.created_at)}</td>
                      <td>
                        <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                          {report.status === 'open' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="check"
                              loading={busy === report.id}
                              onClick={() => void claim(report)}
                            >
                              {t('认领')}
                            </Button>
                          ) : null}
                          {report.status === 'assigned' ? (
                            <>
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="close"
                                onClick={() => {
                                  setPending({ report, action: 'ignore' });
                                  setNote('');
                                }}
                              >
                                {t('忽略')}
                              </Button>
                              {report.target_type !== 'user' ? (
                                <Button
                                  variant="quiet"
                                  size="sm"
                                  icon="eye"
                                  onClick={() => {
                                    setPending({ report, action: 'takedown' });
                                    setNote('');
                                  }}
                                >
                                  {t('下架')}
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                          {can('manage_member') ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="shield"
                              onClick={() => {
                                setPending({ report, action: 'ban' });
                                setNote('');
                              }}
                            >
                              {t('封禁')}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="tiny faint mt-16" style={{ lineHeight: 1.8 }}>
        {t('桌面演示模式把举报保存在浏览器；连接真实后端时使用')}{' '}
        <code className="mono"> GET /reports </code>
        {t('与')}
        <code className="mono"> POST /reports/{'{id}'}/resolve </code>
        {t('。')}
        {demo ? t('演示数据不会写回服务端。') : ''}
      </p>

      <Modal
        open={!!pending}
        title={pending ? t(ACTION_LABEL[pending.action]) : ''}
        description={t('处理结果会通知举报人和被处理的作者，且无法在界面上撤销。')}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('取消')}
            </Button>
            <Button
              variant={pending?.action === 'ignore' ? 'primary' : 'danger'}
              loading={!!pending && busy === pending.report.id}
              onClick={() => void resolve()}
            >
              {pending ? t(ACTION_LABEL[pending.action]) : t('确认')}
            </Button>
          </>
        }
      >
        <Field label={t('处理备注')} htmlFor="report-resolve-note" hint={t('可选：记录判断依据，写入审计日志。')}>
          <Textarea
            id="report-resolve-note"
            value={note}
            maxLength={2000}
            style={{ minHeight: 84 }}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </Modal>
    </RoleGate>
  );
}
